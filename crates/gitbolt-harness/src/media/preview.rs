//! Writes sprites for a person to look at: each one scaled up, a contact sheet of all of them
//! with their names, and an index.html. `gitbolt-harness media preview <dir>`.

use super::canvas::Canvas;
use super::font::{draw_text, BASIC};
use super::palette::{SPACE, STEEL};
use std::path::Path;

pub fn write(dir: &Path, items: &[(String, Canvas, u32)]) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let mut html = String::from("<!doctype html>\n<meta charset=\"utf-8\">\n<title>Orbital art</title>\n<style>body { background: #0e1424; color: #b4bccb; font: 13px system-ui; } figure { display: inline-block; margin: 12px; vertical-align: top; } img { image-rendering: pixelated; }</style>\n");
    let scaled: Vec<(String, Canvas)> = items.iter().map(|(n, c, k)| (n.clone(), c.scaled(*k))).collect();
    for (name, c) in &scaled {
        std::fs::write(dir.join(format!("{name}.png")), c.to_png())?;
        html.push_str(&format!("<figure><img src=\"{name}.png\" width=\"{}\" height=\"{}\"><figcaption>{name}</figcaption></figure>\n", c.w, c.h));
    }
    std::fs::write(dir.join("index.html"), html)?;
    // Contact sheet: rows up to 1,200 px wide, a 2× label under each. A wider item widens the
    // sheet rather than running off its edge.
    const GAP: u32 = 16;
    const LABEL: u32 = 20;
    let cell_w = |item: &(String, Canvas)| item.1.w.max(crate::media::font::text_width(&item.0, 2) as u32);
    let max_w = scaled.iter().map(|i| cell_w(i) + 2 * GAP).max().unwrap_or(0).max(1200);
    let mut rows: Vec<Vec<&(String, Canvas)>> = vec![Vec::new()];
    let mut row_w = GAP;
    for item in &scaled {
        let w = cell_w(item) + GAP;
        if row_w + w > max_w && !rows.last().unwrap().is_empty() {
            rows.push(Vec::new());
            row_w = GAP;
        }
        rows.last_mut().unwrap().push(item);
        row_w += w;
    }
    let height: u32 = GAP + rows.iter().map(|r| r.iter().map(|i| i.1.h).max().unwrap_or(0) + LABEL + GAP).sum::<u32>();
    let mut sheet = Canvas::filled(max_w, height, SPACE[1]);
    let mut y = GAP;
    for row in &rows {
        let mut x = GAP;
        let row_h = row.iter().map(|i| i.1.h).max().unwrap_or(0);
        for &item in row {
            let (name, c) = item;
            sheet.blit(c, x as i32, y as i32);
            draw_text(&mut sheet, BASIC, name, x as i32, (y + row_h + 4) as i32, 2, STEEL[4]);
            x += cell_w(item) + GAP;
        }
        y += row_h + LABEL + GAP;
    }
    std::fs::write(dir.join("contact.png"), sheet.to_png())
}

#[cfg(test)]
mod tests {
    #[test]
    fn writes_each_sprite_a_contact_sheet_and_an_index() {
        let dir = tempfile::tempdir().unwrap();
        let items = crate::media::sprites::specimens();
        super::write(dir.path(), &items).unwrap();
        for (name, _, _) in &items {
            assert!(dir.path().join(format!("{name}.png")).is_file(), "{name}");
        }
        let contact = std::fs::read(dir.path().join("contact.png")).unwrap();
        assert_eq!(&contact[1..4], b"PNG");
        let html = std::fs::read_to_string(dir.path().join("index.html")).unwrap();
        assert!(html.contains("image-rendering: pixelated") && html.contains(&items[0].0));
    }
}
