//! A document on A4: a cover with an illustration; numbered headings kept with what follows;
//! paragraphs and lists that keep two lines together across a page break; tables that split
//! across pages with their header repeated; diagrams; callouts; images; a running header and
//! "Page n of N".

use super::canvas::Canvas;
use super::pdf::{encode_info, image_object, text_width, Font, Ops, Paint, Pdf, Rgb};

pub const INK: Rgb = [24, 33, 58];
pub const MUTED: Rgb = [100, 108, 128];
pub const ACCENT: Rgb = [19, 96, 102];
pub const NAVY: Rgb = [14, 20, 36];
pub const RULE: Rgb = [200, 205, 215];
pub const ZEBRA: Rgb = [240, 242, 246];
pub const TINT: Rgb = [228, 244, 240];
pub const GOLD: Rgb = [240, 149, 58];
pub const VIOLET: Rgb = [116, 70, 163];
pub const TEAL: Rgb = [31, 143, 138];
pub const RED: Rgb = [201, 52, 74];
pub const WHITE: Rgb = [255, 255, 255];
const PANEL: Rgb = [248, 249, 251];

const PAGE_W: f32 = 595.0;
const PAGE_H: f32 = 842.0;
const LEFT: f32 = 64.0;
pub const CONTENT_W: f32 = 467.0;
const TOP: f32 = 760.0;
const BOTTOM: f32 = 76.0;

const BODY: f32 = 10.5;
const LEAD: f32 = 15.0;
/// Where heading text starts, after its number.
const HANG: f32 = 30.0;
const CAPTION: f32 = 8.5;
const CELL: f32 = 9.0;
const CELL_LEAD: f32 = 12.0;
const CELL_PAD: f32 = 6.0;
const HEADER_ROW: f32 = 20.0;
/// What a table's caption and header take above its first row (see `table`'s `open`).
const OPEN_H: f32 = 16.0 + HEADER_ROW + 1.0;
/// Fewest rows a table keeps on either side of a page break; fewer, and it moves whole.
const SPLIT_MIN_ROWS: usize = 3;

pub struct Doc {
    pub title: String,
    pub subtitle: String,
    pub author: String,
    /// YYYY-MM-DD
    pub date: String,
    pub meta: Vec<(String, String)>,
    pub cover: Option<Canvas>,
    pub blocks: Vec<Block>,
}

pub enum Block {
    H1(String),
    H2(String),
    Para(String),
    Bullets(Vec<String>),
    Table(Table),
    Diagram(Diagram),
    Callout(String),
    Image { canvas: Canvas, scale: f32, caption: String },
    PageBreak,
}

pub struct Table {
    pub columns: Vec<Column>,
    pub rows: Vec<Vec<String>>,
    pub caption: String,
}

pub struct Column {
    pub title: String,
    /// A fraction of the table's width (the columns' fractions are normalised).
    pub width: f32,
    pub right: bool,
}

/// Shapes in diagram space: x runs 0..CONTENT_W, y down from the diagram's top.
pub struct Diagram {
    pub height: f32,
    pub shapes: Vec<Shape>,
    pub caption: String,
}

pub enum Shape {
    Ellipse { cx: f32, cy: f32, rx: f32, ry: f32, colour: Rgb, dashed: bool },
    Disc { cx: f32, cy: f32, r: f32, colour: Rgb },
    Box { x: f32, y: f32, w: f32, h: f32, fill: Rgb, label: String },
    Arrow { from: (f32, f32), to: (f32, f32), colour: Rgb },
    Line { from: (f32, f32), to: (f32, f32), colour: Rgb, dashed: bool },
    Label { x: f32, y: f32, text: String, size: f32, colour: Rgb, bold: bool },
}

struct Layout {
    pages: Vec<Ops>,
    /// Each page's running-header section: the one open at its top, or the one it starts with.
    sections: Vec<String>,
    section: String,
    y: f32,
    h1: u32,
    h2: u32,
    figures: u32,
    tables: u32,
    images: Vec<(String, Canvas)>,
}

impl Layout {
    fn page(&mut self) -> &mut Ops {
        self.pages.last_mut().expect("a page")
    }
    fn new_page(&mut self) {
        self.pages.push(Ops::default());
        self.sections.push(self.section.clone());
        self.y = TOP;
    }
    fn need(&mut self, h: f32) {
        if self.y - h < BOTTOM {
            self.new_page();
        }
    }
    fn at_top(&self) -> bool {
        self.y >= TOP
    }
    /// Space before a block, dropped at the top of a page.
    fn gap(&mut self, h: f32) {
        if !self.at_top() {
            self.y -= h;
        }
    }
}

fn wrap(font: Font, size: f32, text: &str, width: f32) -> Vec<String> {
    let mut lines = Vec::new();
    let mut line = String::new();
    for word in text.split_whitespace() {
        let candidate = if line.is_empty() { word.to_string() } else { format!("{line} {word}") };
        if !line.is_empty() && text_width(font, size, &candidate) > width {
            lines.push(std::mem::replace(&mut line, word.to_string()));
        } else {
            line = candidate;
        }
    }
    if !line.is_empty() {
        lines.push(line);
    }
    lines
}

fn luma(c: Rgb) -> f32 {
    0.2126 * c[0] as f32 + 0.7152 * c[1] as f32 + 0.0722 * c[2] as f32
}

fn darker(c: Rgb, k: f32) -> Rgb {
    c.map(|v| (v as f32 * k) as u8)
}

/// "2025-02-20" as "20 February 2025" (anything else as given).
fn long_date(date: &str) -> String {
    const MONTHS: [&str; 12] = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    let parts: Vec<&str> = date.split('-').collect();
    match (parts.as_slice(), parts.get(1).and_then(|m| m.parse::<usize>().ok()), parts.get(2).and_then(|d| d.parse::<u32>().ok())) {
        ([y, _, _], Some(m @ 1..=12), Some(d)) => format!("{d} {} {y}", MONTHS[m - 1]),
        _ => date.to_string(),
    }
}

pub fn render(doc: &Doc) -> Vec<u8> {
    let mut l = paginate(doc);
    let n = l.pages.len();
    for (i, page) in l.pages.iter_mut().enumerate().skip(1) {
        page.fill(INK);
        page.text(Font::Bold, 8.0, LEFT, 794.0, &doc.title);
        let section = &l.sections[i];
        page.fill(MUTED);
        page.text(Font::Regular, 8.0, LEFT + CONTENT_W - text_width(Font::Regular, 8.0, section), 794.0, section);
        page.stroke(RULE);
        page.width(0.5);
        page.line(LEFT, 786.0, LEFT + CONTENT_W, 786.0);
        let label = format!("Page {} of {n}", i + 1);
        page.fill(MUTED);
        page.text(Font::Regular, 8.0, (PAGE_W - text_width(Font::Regular, 8.0, &label)) / 2.0, 42.0, &label);
    }
    assemble(doc, l)
}

fn paginate(doc: &Doc) -> Layout {
    let mut l = Layout { pages: Vec::new(), sections: Vec::new(), section: String::new(), y: TOP, h1: 0, h2: 0, figures: 0, tables: 0, images: Vec::new() };
    cover(&mut l, doc);
    l.new_page();
    for (i, block) in doc.blocks.iter().enumerate() {
        place(&mut l, block, &doc.blocks[i + 1..]);
    }
    l
}

/// The illustration bleeds across the top; under it a band in the lane colours, the title, and
/// the document's particulars in a row of labelled columns at the foot.
fn cover(l: &mut Layout, doc: &Doc) {
    l.new_page();
    let p = l.page();
    let mut y = PAGE_H;
    if let Some(c) = &doc.cover {
        let h = PAGE_W * c.h as f32 / c.w as f32;
        p.image("/Im0", 0.0, PAGE_H - h, PAGE_W, h);
        y -= h;
    } else {
        p.fill(NAVY);
        p.rect(0.0, PAGE_H - 220.0, PAGE_W, 220.0, Paint::Fill);
        y -= 220.0;
    }
    let band = PAGE_W / 4.0;
    for (i, c) in [TEAL, GOLD, VIOLET, RED].into_iter().enumerate() {
        p.fill(c);
        p.rect(band * i as f32, y - 5.0, band, 5.0, Paint::Fill);
    }
    let mut ty = y - 72.0;
    p.fill(INK);
    for line in wrap(Font::Bold, 32.0, &doc.title, CONTENT_W) {
        p.text(Font::Bold, 32.0, LEFT, ty, &line);
        ty -= 38.0;
    }
    p.fill(ACCENT);
    p.text(Font::Regular, 15.0, LEFT, ty + 8.0, &doc.subtitle);

    let mut fields = vec![("Author".to_string(), doc.author.clone()), ("Date".to_string(), long_date(&doc.date))];
    fields.extend(doc.meta.iter().cloned());
    let per_row = 4;
    let col = CONTENT_W / per_row as f32;
    let rows = fields.len().div_ceil(per_row);
    let mut fy = 96.0 + (rows as f32 - 1.0) * 36.0;
    p.stroke(RULE);
    p.width(0.5);
    p.line(LEFT, fy + 30.0, LEFT + CONTENT_W, fy + 30.0);
    for row in fields.chunks(per_row) {
        for (i, (k, v)) in row.iter().enumerate() {
            let x = LEFT + i as f32 * col;
            p.fill(MUTED);
            p.text(Font::Bold, 7.5, x, fy + 12.0, &k.to_uppercase());
            p.fill(INK);
            p.text(Font::Regular, 10.5, x, fy - 2.0, v);
        }
        fy -= 36.0;
    }
}

fn place(l: &mut Layout, block: &Block, rest: &[Block]) {
    match block {
        Block::H1(text) => {
            l.h1 += 1;
            l.h2 = 0;
            l.section = format!("{}  {text}", l.h1);
            l.need(22.0 + 40.0 + keep_with_next(rest));
            l.gap(22.0);
            if l.at_top() {
                *l.sections.last_mut().expect("a page") = l.section.clone();
            }
            let number = l.h1.to_string();
            heading(l, &number, text, Font::Bold, 17.0);
            let (y, p) = (l.y, l.page());
            p.stroke(RULE);
            p.width(0.5);
            p.line(LEFT, y - 26.0, LEFT + CONTENT_W, y - 26.0);
            p.fill(ACCENT);
            p.rect(LEFT, y - 27.0, 36.0, 2.0, Paint::Fill);
            l.y -= 40.0;
        }
        Block::H2(text) => {
            l.h2 += 1;
            l.need(14.0 + 22.0 + keep_with_next(rest));
            l.gap(14.0);
            let number = format!("{}.{}", l.h1, l.h2);
            heading(l, &number, text, Font::Bold, 12.0);
            l.y -= 22.0;
        }
        Block::Para(text) => {
            let lines = wrap(Font::Regular, BODY, text, CONTENT_W);
            flow(l, &lines, LEFT, None);
            l.y -= 7.0;
        }
        Block::Bullets(items) => {
            for item in items {
                let lines = wrap(Font::Regular, BODY, item, CONTENT_W - 16.0);
                flow(l, &lines, LEFT + 16.0, Some("\u{2022}"));
                l.y -= 3.0;
            }
            l.y -= 4.0;
        }
        Block::Callout(text) => {
            let lines = wrap(Font::Regular, 10.0, text, CONTENT_W - 32.0);
            let h = lines.len() as f32 * 14.0 + 18.0;
            l.need(h + 6.0);
            l.gap(4.0);
            let y = l.y;
            let p = l.page();
            p.fill(TINT);
            p.round_rect(LEFT, y - h, CONTENT_W, h, 3.0, Paint::Fill);
            p.fill(ACCENT);
            p.rect(LEFT, y - h, 3.0, h, Paint::Fill);
            p.fill(INK);
            for (i, line) in lines.iter().enumerate() {
                p.text(Font::Regular, 10.0, LEFT + 18.0, y - 9.0 - 10.0 - i as f32 * 14.0, line);
            }
            l.y -= h + 14.0;
        }
        Block::Table(t) => table(l, t),
        Block::Diagram(d) => diagram(l, d),
        Block::Image { canvas, scale, caption } => {
            let w = (canvas.w as f32 * scale).min(CONTENT_W);
            let h = w * canvas.h as f32 / canvas.w as f32;
            l.need(h + 30.0);
            l.gap(4.0);
            l.figures += 1;
            let name = format!("/Im{}", l.images.len() + 1);
            l.images.push((name.clone(), canvas.clone()));
            let (y, n) = (l.y, l.figures);
            let p = l.page();
            p.image(&name, LEFT + (CONTENT_W - w) / 2.0, y - h, w, h);
            caption_at(p, "Figure", n, caption, LEFT + (CONTENT_W - w) / 2.0, y - h - 14.0);
            l.y -= h + 32.0;
        }
        Block::PageBreak => {
            if !l.at_top() {
                l.new_page();
            }
        }
    }
}

/// What must fit under a heading to keep it with what follows. When an H2 follows an H1, the H2's
/// own height and lead-in count too, or the H1 is left alone at the foot of a page.
fn keep_with_next(rest: &[Block]) -> f32 {
    match rest {
        [Block::H2(_), after, ..] => 14.0 + 22.0 + lead_in(after),
        [next, ..] => lead_in(next),
        [] => 0.0,
    }
}

/// How much of a block must follow its heading on the same page: two lines of text, a table's
/// caption, header and first rows, a whole figure or callout.
fn lead_in(block: &Block) -> f32 {
    match block {
        Block::Para(_) | Block::Bullets(_) => 2.0 * LEAD,
        Block::Table(_) => 16.0 + HEADER_ROW + 2.0 * (CELL_LEAD + 8.0),
        Block::Diagram(d) => d.height + 34.0,
        Block::Image { canvas, scale, .. } => (canvas.w as f32 * scale).min(CONTENT_W) * canvas.h as f32 / canvas.w as f32 + 34.0,
        Block::Callout(text) => wrap(Font::Regular, 10.0, text, CONTENT_W - 32.0).len() as f32 * 14.0 + 22.0,
        Block::H1(_) | Block::H2(_) | Block::PageBreak => 0.0,
    }
}

/// A numbered heading: the number in the accent colour, the text at the hang.
fn heading(l: &mut Layout, number: &str, text: &str, font: Font, size: f32) {
    let y = l.y - size;
    let x = LEFT + HANG.max(text_width(font, size, number) + 8.0);
    let p = l.page();
    p.fill(ACCENT);
    p.text(font, size, LEFT, y, number);
    p.fill(INK);
    p.text(font, size, x, y, text);
}

/// Lines of body text from `l.y` down, across pages as needed, never leaving one line of a
/// paragraph alone at the foot or head of a page. Set ragged right: without hyphenation,
/// justified Helvetica opens rivers. A marker (a bullet) sits in the gutter of the first line.
fn flow(l: &mut Layout, lines: &[String], x: f32, marker: Option<&str>) {
    let mut i = 0;
    while i < lines.len() {
        let fit = ((l.y - BOTTOM) / LEAD).floor().max(0.0) as usize;
        let rest = lines.len() - i;
        let take = if rest <= fit {
            rest
        } else if rest - fit == 1 {
            fit.saturating_sub(1)
        } else {
            fit
        };
        if take < rest.min(2) && !l.at_top() {
            l.new_page();
            continue;
        }
        let take = take.max(1);
        for (j, line) in lines[i..i + take].iter().enumerate() {
            let k = i + j;
            let y = l.y - BODY;
            let p = l.page();
            if k == 0
                && let Some(m) = marker
            {
                p.fill(ACCENT);
                p.text(Font::Bold, BODY, x - 12.0, y, m);
            }
            p.fill(INK);
            p.text(Font::Regular, BODY, x, y, line);
            l.y -= LEAD;
        }
        i += take;
        if i < lines.len() {
            l.new_page();
        }
    }
}

/// "Figure 3  A transfer orbit": the label in bold, then the caption, in the muted colour.
fn caption_at(p: &mut Ops, kind: &str, n: u32, caption: &str, x: f32, y: f32) {
    let label = format!("{kind} {n}");
    p.fill(INK);
    p.text(Font::Bold, CAPTION, x, y, &label);
    p.fill(MUTED);
    p.text(Font::Regular, CAPTION, x + text_width(Font::Bold, CAPTION, &label) + 8.0, y, caption);
}

/// Where a table's rows break across pages: the index of each page's first row, 0 first. Rows fill
/// a page to its room; then the last page takes rows back from the one before it until it holds
/// `SPLIT_MIN_ROWS`, so no page is left with a stub.
fn breaks(heights: &[f32], first: f32, cont: f32) -> Vec<usize> {
    let mut starts = vec![0];
    let mut room = first;
    for (i, &h) in heights.iter().enumerate() {
        if i > 0 && h > room {
            starts.push(i);
            room = cont;
        }
        room -= h;
    }
    if starts.len() > 1 {
        let last = starts.len() - 1;
        let want = heights.len().saturating_sub(SPLIT_MIN_ROWS);
        if heights.len() - starts[last] < SPLIT_MIN_ROWS && want > starts[last - 1] {
            starts[last] = want;
        }
    }
    starts
}

/// A ruled table: a heavy rule over a bold header, a light one under it, zebra rows and a heavy
/// rule to close. A page break closes the table and opens it again under its caption and header.
fn table(l: &mut Layout, t: &Table) {
    let total: f32 = t.columns.iter().map(|c| c.width).sum();
    let widths: Vec<f32> = t.columns.iter().map(|c| c.width / total * CONTENT_W).collect();
    let rows: Vec<Vec<Vec<String>>> = t.rows.iter().map(|row| row.iter().zip(&widths).map(|(cell, w)| wrap(Font::Regular, CELL, cell, w - 2.0 * CELL_PAD)).collect()).collect();
    let height = |cells: &Vec<Vec<String>>| cells.iter().map(Vec::len).max().unwrap_or(1).max(1) as f32 * CELL_LEAD + 8.0;
    l.tables += 1;
    let n = l.tables;
    let open = |l: &mut Layout, continued: bool| {
        let y = l.y;
        let caption = if continued { format!("{} (continued)", t.caption) } else { t.caption.clone() };
        let p = l.page();
        caption_at(p, "Table", n, &caption, LEFT, y - CAPTION);
        let y = y - 16.0;
        p.stroke(INK);
        p.width(1.0);
        p.line(LEFT, y, LEFT + CONTENT_W, y);
        p.fill(INK);
        let mut x = LEFT;
        for (c, w) in t.columns.iter().zip(&widths) {
            let tx = if c.right { x + w - CELL_PAD - text_width(Font::Bold, CELL, &c.title) } else { x + CELL_PAD };
            p.text(Font::Bold, CELL, tx, y - 13.5, &c.title);
            x += w;
        }
        p.width(0.6);
        p.line(LEFT, y - HEADER_ROW, LEFT + CONTENT_W, y - HEADER_ROW);
        l.y = y - HEADER_ROW - 1.0;
    };
    let close = |l: &mut Layout| {
        let y = l.y;
        let p = l.page();
        p.stroke(INK);
        p.width(1.0);
        p.line(LEFT, y, LEFT + CONTENT_W, y);
    };
    l.gap(6.0);
    l.need(16.0 + HEADER_ROW + rows.first().map_or(0.0, height) * 2.0);
    let heights: Vec<f32> = rows.iter().map(height).collect();
    let full = TOP - OPEN_H - BOTTOM;
    let mut starts = breaks(&heights, l.y - OPEN_H - BOTTOM, full);
    // A short table moves whole rather than splitting; a longer one moves when too little would stay above the break.
    if starts.len() > 1 && (rows.len() < 2 * SPLIT_MIN_ROWS || starts[1] < SPLIT_MIN_ROWS) && !l.at_top() {
        l.new_page();
        starts = breaks(&heights, full, full);
    }
    open(l, false);
    for (r, cells) in rows.iter().enumerate() {
        let h = heights[r];
        if r > 0 && starts.contains(&r) {
            close(l);
            l.new_page();
            open(l, true);
        }
        let y = l.y;
        let p = l.page();
        if r % 2 == 1 {
            p.fill(ZEBRA);
            p.rect(LEFT, y - h, CONTENT_W, h, Paint::Fill);
        }
        p.fill(INK);
        let mut x = LEFT;
        for ((lines, w), col) in cells.iter().zip(&widths).zip(&t.columns) {
            for (i, line) in lines.iter().enumerate() {
                let tx = if col.right { x + w - CELL_PAD - text_width(Font::Regular, CELL, line) } else { x + CELL_PAD };
                p.text(Font::Regular, CELL, tx, y - 13.0 - i as f32 * CELL_LEAD, line);
            }
            x += w;
        }
        l.y -= h;
    }
    close(l);
    l.y -= 22.0;
}

fn diagram(l: &mut Layout, d: &Diagram) {
    l.need(d.height + 30.0);
    l.gap(4.0);
    l.figures += 1;
    let (top, n) = (l.y, l.figures);
    let (px, py) = (|x: f32| LEFT + x, |y: f32| top - y);
    let p = l.page();
    p.fill(PANEL);
    p.stroke(RULE);
    p.width(0.5);
    p.round_rect(LEFT, top - d.height, CONTENT_W, d.height, 4.0, Paint::Both);
    for s in &d.shapes {
        match s {
            Shape::Ellipse { cx, cy, rx, ry, colour, dashed } => {
                p.stroke(*colour);
                p.width(1.2);
                if *dashed {
                    p.dash(4.0, 3.0);
                }
                p.ellipse(px(*cx), py(*cy), *rx, *ry, Paint::Stroke);
                p.solid();
            }
            Shape::Disc { cx, cy, r, colour } => {
                p.fill(*colour);
                p.ellipse(px(*cx), py(*cy), *r, *r, Paint::Fill);
            }
            Shape::Box { x, y, w, h, fill, label } => {
                p.fill(*fill);
                p.stroke(darker(*fill, 0.7));
                p.width(0.6);
                p.round_rect(px(*x), py(*y + *h), *w, *h, 3.0, Paint::Both);
                p.fill(if luma(*fill) < 140.0 { WHITE } else { INK });
                let tw = text_width(Font::Bold, 8.5, label);
                p.text(Font::Bold, 8.5, px(*x) + (w - tw) / 2.0, py(*y + h / 2.0) - 3.0, label);
            }
            Shape::Arrow { from, to, colour } => {
                let (x0, y0, x1, y1) = (px(from.0), py(from.1), px(to.0), py(to.1));
                let len = (x1 - x0).hypot(y1 - y0).max(0.001);
                let (dx, dy) = ((x1 - x0) / len, (y1 - y0) / len);
                p.stroke(*colour);
                p.width(1.2);
                p.line(x0, y0, x1 - dx * 6.0, y1 - dy * 6.0);
                p.fill(*colour);
                p.polygon(&[(x1, y1), (x1 - dx * 8.0 - dy * 3.5, y1 - dy * 8.0 + dx * 3.5), (x1 - dx * 8.0 + dy * 3.5, y1 - dy * 8.0 - dx * 3.5)], Paint::Fill);
            }
            Shape::Line { from, to, colour, dashed } => {
                p.stroke(*colour);
                p.width(0.8);
                if *dashed {
                    p.dash(3.0, 3.0);
                }
                p.line(px(from.0), py(from.1), px(to.0), py(to.1));
                p.solid();
            }
            Shape::Label { x, y, text, size, colour, bold } => {
                p.fill(*colour);
                p.text(if *bold { Font::Bold } else { Font::Regular }, *size, px(*x), py(*y), text);
            }
        }
    }
    caption_at(p, "Figure", n, &d.caption, LEFT, top - d.height - 14.0);
    l.y -= d.height + 32.0;
}

fn assemble(doc: &Doc, l: Layout) -> Vec<u8> {
    let mut pdf = Pdf::default();
    let catalog = pdf.reserve();
    let pages_id = pdf.reserve();
    let fonts: Vec<usize> = [Font::Regular, Font::Bold, Font::Italic, Font::Mono]
        .iter()
        .map(|f| pdf.add(format!("<< /Type /Font /Subtype /Type1 /BaseFont /{} /Encoding /WinAnsiEncoding >>", f.base())))
        .collect();
    let mut xobjects = String::new();
    if let Some(c) = &doc.cover {
        xobjects += &format!("/Im0 {} 0 R ", pdf.add(image_object(c)));
    }
    for (name, c) in &l.images {
        xobjects += &format!("{name} {} 0 R ", pdf.add(image_object(c)));
    }
    let resources = pdf.add(format!("<< /Font << /F1 {} 0 R /F2 {} 0 R /F3 {} 0 R /F4 {} 0 R >> /XObject << {xobjects}>> >>", fonts[0], fonts[1], fonts[2], fonts[3]));
    let mut kids = Vec::new();
    for page in l.pages {
        let content = pdf.add(Pdf::stream("", page.0.as_bytes()));
        let id = pdf.add(format!("<< /Type /Page /Parent {pages_id} 0 R /MediaBox [0 0 595 842] /Resources {resources} 0 R /Contents {content} 0 R >>"));
        kids.push(format!("{id} 0 R"));
    }
    pdf.set(pages_id, format!("<< /Type /Pages /Kids [{}] /Count {} >>", kids.join(" "), kids.len()));
    pdf.set(catalog, format!("<< /Type /Catalog /Pages {pages_id} 0 R /Lang (en) /ViewerPreferences << /DisplayDocTitle true >> >>"));
    let date = format!("(D:{}120000Z)", doc.date.replace('-', ""));
    let info = pdf.add(format!(
        "<< /Title {} /Author {} /Subject {} /Creator (Orbital docs) /Producer (GitBolt showcase) /CreationDate {date} /ModDate {date} >>",
        encode_info(&doc.title),
        encode_info(&doc.author),
        encode_info(&doc.subtitle),
    ));
    pdf.finish(catalog, info)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::pdf::encode;

    fn find(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).position(|w| w == needle)
    }
    fn rfind(hay: &[u8], needle: &[u8]) -> Option<usize> {
        hay.windows(needle.len()).rposition(|w| w == needle)
    }

    fn sample() -> Doc {
        Doc {
            title: "Orbital design".into(),
            subtitle: "Game design document".into(),
            author: "Wen Castellano".into(),
            date: "2025-02-20".into(),
            meta: vec![("Version".into(), "0.4".into()), ("Status".into(), "Draft".into())],
            cover: Some(Canvas::filled(48, 27, 3)),
            blocks: vec![
                Block::H1("Overview".into()),
                Block::Para("Orbital is a game about orbits, cargo and bad decisions. ".repeat(60)),
                Block::H2("The loop".into()),
                Block::Bullets(vec!["Fly between stations".into(), "Trade what you carry".into()]),
                Block::Callout("Fuel is the one resource you can't buy back mid-burn.".into()),
                Block::Table(Table {
                    columns: vec![Column { title: "Ship".into(), width: 0.6, right: false }, Column { title: "Cargo".into(), width: 0.4, right: true }],
                    rows: (0..80).map(|i| vec![format!("Ship {i}"), format!("{i} t")]).collect(),
                    caption: "Ship classes".into(),
                }),
                Block::Diagram(Diagram {
                    height: 160.0,
                    caption: "A transfer orbit".into(),
                    shapes: vec![
                        Shape::Disc { cx: 233.0, cy: 80.0, r: 20.0, colour: TEAL },
                        Shape::Ellipse { cx: 233.0, cy: 80.0, rx: 120.0, ry: 50.0, colour: GOLD, dashed: true },
                        Shape::Arrow { from: (40.0, 140.0), to: (120.0, 100.0), colour: INK },
                        Shape::Box { x: 300.0, y: 20.0, w: 100.0, h: 30.0, fill: NAVY, label: "Station".into() },
                        Shape::Line { from: (0.0, 80.0), to: (467.0, 80.0), colour: RULE, dashed: true },
                        Shape::Label { x: 10.0, y: 20.0, text: "Burn here".into(), size: 9.0, colour: INK, bold: true },
                    ],
                }),
                Block::Image { canvas: Canvas::filled(32, 18, 12), scale: 6.0, caption: "The title".into() },
            ],
        }
    }

    #[test]
    fn xref_offsets_and_stream_lengths_are_right() {
        let pdf = render(&sample());
        assert!(pdf.starts_with(b"%PDF-1.7\n"));
        let sx = rfind(&pdf, b"startxref\n").unwrap() + 10;
        let end = sx + pdf[sx..].iter().position(|&b| b == b'\n').unwrap();
        let xref: usize = std::str::from_utf8(&pdf[sx..end]).unwrap().parse().unwrap();
        assert!(pdf[xref..].starts_with(b"xref\n0 "));
        let table = std::str::from_utf8(&pdf[xref..sx]).unwrap();
        for (i, line) in table.lines().skip(3).take_while(|l| l.ends_with(" n ")).enumerate() {
            let off: usize = line[..10].parse().unwrap();
            assert!(pdf[off..].starts_with(format!("{} 0 obj\n", i + 1).as_bytes()), "object {}", i + 1);
        }
        let mut at = 0;
        while let Some(s) = find(&pdf[at..], b">>\nstream\n") {
            let start = at + s + 10;
            let dict_start = rfind(&pdf[..start], b"<<").unwrap();
            let dict = std::str::from_utf8(&pdf[dict_start..start]).unwrap();
            let len: usize = dict.split("/Length ").nth(1).unwrap().split(' ').next().unwrap().parse().unwrap();
            assert!(pdf[start + len..].starts_with(b"\nendstream"), "stream at {start}");
            at = start + len;
        }
    }

    #[test]
    fn content_flows_across_pages_and_tables_repeat_their_header() {
        let pdf = render(&sample());
        let text = String::from_utf8_lossy(&pdf);
        let count: usize = text.split("/Count ").nth(1).unwrap().split(' ').next().unwrap().parse().unwrap();
        assert!(count >= 4, "cover, long paragraph, long table: {count} pages");
        let Ok(dir) = tempfile::tempdir() else { return };
        let path = dir.path().join("doc.pdf");
        std::fs::write(&path, &pdf).unwrap();
        let Ok(info) = std::process::Command::new("pdfinfo").arg(&path).output() else {
            eprintln!("skipping: no poppler-utils");
            return;
        };
        let info = String::from_utf8_lossy(&info.stdout);
        // Poppler pads its labels to its longest one, which varies by version.
        let field = |name: &str| info.lines().find_map(|l| l.strip_prefix(name)).map(str::trim);
        assert_eq!(field("Title:"), Some("Orbital design"), "{info}");
        assert_eq!(field("Pages:"), Some(count.to_string().as_str()), "{info}");
        let out = std::process::Command::new("pdftotext").arg(&path).arg("-").output().unwrap();
        let text = String::from_utf8_lossy(&out.stdout);
        for want in ["Overview", "The loop", "Fly between stations", "Ship 79", "A transfer orbit", "Burn here", &format!("Page {count} of {count}")] {
            assert!(text.contains(want), "{want:?} in the text");
        }
        assert!(text.matches("Cargo").count() >= 2, "the table's header repeats on its second page");
    }

    fn bare(blocks: Vec<Block>) -> Doc {
        Doc { title: "Orbital design".into(), subtitle: "Notes".into(), author: "Wen Castellano".into(), date: "2025-02-20".into(), meta: Vec::new(), cover: None, blocks }
    }

    #[test]
    fn an_h1_is_never_left_alone_above_its_h2() {
        // The filler's length sweeps the heading through every height on the page.
        for words in 1..900 {
            let doc = bare(vec![
                Block::Para("filler ".repeat(words)),
                Block::H1("Heading".into()),
                Block::H2("Subhead".into()),
                Block::Para("Body text under the subhead.".into()),
            ]);
            let l = paginate(&doc);
            let page_of = |text: &str| l.pages.iter().position(|p| p.0.contains(&encode(text))).expect(text);
            assert_eq!(page_of("Heading"), page_of("Subhead"), "{words} words of filler");
        }
    }

    #[test]
    fn a_split_table_keeps_three_rows_on_each_side_or_moves_whole() {
        // The filler's length sweeps the table's break through every row of a page.
        for rows_n in [5, 8] {
            for words in 1..700 {
                let rows: Vec<Vec<String>> = (0..rows_n).map(|i| vec![format!("Row {i}"), "Some words in the cell".into()]).collect();
                let columns = vec![Column { title: "Item".into(), width: 0.5, right: false }, Column { title: "Note".into(), width: 0.5, right: false }];
                let doc = bare(vec![Block::Para("filler ".repeat(words)), Block::Table(Table { columns, rows, caption: "Sizes".into() })]);
                let l = paginate(&doc);
                let counts: Vec<usize> = l.pages.iter().map(|p| p.0.matches("(Row ").count()).filter(|&c| c > 0).collect();
                assert_eq!(counts.iter().sum::<usize>(), rows_n, "{words} words: {counts:?}");
                assert!(counts.len() == 1 || counts.iter().all(|&c| c >= SPLIT_MIN_ROWS), "{rows_n} rows, {words} words of filler: {counts:?}");
            }
        }
    }

    #[test]
    fn info_strings_are_pdfdocencoded() {
        assert_eq!(encode_info("Orbital \u{2014} design"), "(Orbital \\204 design)");
        assert_eq!(encode_info("\u{201C}a\u{201D} \u{2018}b\u{2019} \u{2013}\u{2022}\u{2026}"), "(\\215a\\216 \\217b\\220 \\205\\200\\203)");
        assert_eq!(encode_info("caf\u{e9} \u{4e2d}"), "(caf\\351 ?)");
        let pdf = render(&bare(vec![Block::Para("Text.".into())]));
        let mut doc = bare(vec![Block::Para("Text.".into())]);
        doc.title = "Orbital \u{2014} design".into();
        let pdf_titled = render(&doc);
        assert!(find(&pdf_titled, b"/Title (Orbital \\204 design)").is_some());
        assert!(find(&pdf, b"/Title (Orbital design)").is_some());
        let Ok(dir) = tempfile::tempdir() else { return };
        let path = dir.path().join("titled.pdf");
        std::fs::write(&path, &pdf_titled).unwrap();
        let Ok(info) = std::process::Command::new("pdfinfo").arg(&path).output() else {
            eprintln!("skipping: no poppler-utils");
            return;
        };
        let info = String::from_utf8_lossy(&info.stdout);
        let title = info.lines().find_map(|l| l.strip_prefix("Title:")).map(str::trim);
        assert_eq!(title, Some("Orbital \u{2014} design"), "{info}");
    }

    #[test]
    fn rendering_repeats_and_strings_are_escaped() {
        assert_eq!(render(&sample()), render(&sample()));
        assert_eq!(crate::media::pdf::encode("a (b) \\ é — •"), "(a \\(b\\) \\\\ \\351 \\227 \\225)");
        assert!(crate::media::pdf::text_width(Font::Bold, 10.0, "WWW") > crate::media::pdf::text_width(Font::Regular, 10.0, "iii") * 3.0);
    }
}
