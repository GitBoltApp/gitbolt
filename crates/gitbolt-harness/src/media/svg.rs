//! Pixel art as SVG: one `<rect>` per horizontal run of a colour, crisp edges.

use super::canvas::Canvas;
use super::palette::PALETTE;

pub fn from_canvas(c: &Canvas, scale: u32) -> String {
    let mut s = format!(
        "<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"{}\" height=\"{}\" viewBox=\"0 0 {} {}\" shape-rendering=\"crispEdges\">\n",
        c.w * scale, c.h * scale, c.w, c.h
    );
    for y in 0..c.h as i32 {
        let mut x = 0;
        while x < c.w as i32 {
            let p = c.get(x, y);
            let start = x;
            while x < c.w as i32 && c.get(x, y) == p {
                x += 1;
            }
            if p != 0 {
                let [r, g, b, _] = PALETTE[p as usize];
                s.push_str(&format!("  <rect x=\"{start}\" y=\"{y}\" width=\"{}\" height=\"1\" fill=\"#{r:02x}{g:02x}{b:02x}\"/>\n", x - start));
            }
        }
    }
    s.push_str("</svg>\n");
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::palette::{GOLD, TEAL};

    #[test]
    fn svg_merges_runs_and_is_crisp() {
        let mut c = Canvas::new(4, 2);
        c.fill_rect(0, 0, 3, 1, GOLD[3]);
        c.set(3, 1, TEAL[2]);
        let s = from_canvas(&c, 8);
        assert!(s.starts_with("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"32\" height=\"16\" viewBox=\"0 0 4 2\" shape-rendering=\"crispEdges\">"));
        assert_eq!(s.matches("<rect").count(), 2, "{s}");
        assert!(s.contains("<rect x=\"0\" y=\"0\" width=\"3\" height=\"1\" fill=\"#f0953a\"/>"));
        assert!(s.ends_with("</svg>\n"));
    }

    /// Well-formed XML (python's parser), and a rasterised render when cairosvg or rsvg-convert
    /// is here; each part skips when its tool is missing.
    #[test]
    fn svg_parses_as_xml_and_renders() {
        let mut c = Canvas::new(6, 4);
        c.fill_rect(1, 1, 4, 2, GOLD[3]);
        let s = from_canvas(&c, 4);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("probe.svg");
        std::fs::write(&path, &s).unwrap();
        let script = "import sys\nimport xml.etree.ElementTree as ET\nr = ET.parse(sys.argv[1]).getroot()\nprint(len(list(r)))";
        match std::process::Command::new("python3").arg("-I").arg("-c").arg(script).arg(&path).output() {
            Ok(o) if o.status.success() => assert_eq!(String::from_utf8_lossy(&o.stdout).trim(), "2"),
            Ok(o) => panic!("not well-formed XML: {}", String::from_utf8_lossy(&o.stderr)),
            Err(_) => eprintln!("skipping the XML check: no python3"),
        }
        let png = dir.path().join("probe.png");
        match std::process::Command::new("rsvg-convert").arg("-o").arg(&png).arg(&path).output() {
            Ok(o) => {
                assert!(o.status.success(), "rsvg-convert: {}", String::from_utf8_lossy(&o.stderr));
                let bytes = std::fs::read(&png).unwrap();
                if let Some((f, w, h, _)) = crate::media::check::pillow(&bytes, "png") {
                    assert_eq!((f.as_str(), w, h), ("PNG", 24, 16));
                }
            }
            Err(_) => eprintln!("skipping the SVG render check: no rsvg-convert"),
        }
    }
}
