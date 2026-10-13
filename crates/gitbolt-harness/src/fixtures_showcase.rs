//! Showcase repositories for the playground and screenshots (`gitbolt-harness fixture <name>`):
//! files the diff and File View preview instead of showing as text, submodules in each state, and
//! Git LFS without git-lfs. Everything is made up and built offline; the media in `fixture_data/`
//! were synthesized for these fixtures with ffmpeg (a Game of Life pattern, a test card and three
//! sine tones).
//!
//! - `previews`: "Add the gallery" then "Refresh the gallery" change every file: a PNG, a WAV, a
//!   WebM, a TrueType font (generated here), a PDF (one page, then two), a static HTML page with
//!   its stylesheet and an image, a page loading a CDN script, a CSV and a TSV (rows added,
//!   removed and changed), Markdown with front matter and an SVG. An Ogg Opus chime and a shell
//!   script come with the first commit.
//! - `submodules`: `libs/parser` (moved from "Parse the header" to "Parse the body" by a commit,
//!   then checked out at a newer commit with an edited file) and `libs/theme` (recorded, never
//!   initialised); their sources sit beside the repository.
//! - `lfs`: `*.png` and `*.psd` stored with LFS. The cover's two versions are in the local store
//!   (an LFS image diff); the layered `.psd` never was ("not downloaded").

use gitbolt_core::testing::TestRepo;
use sha2::{Digest, Sha256};

const DEMO_V1: &[u8] = include_bytes!("fixture_data/demo-v1.webm");
const DEMO_V2: &[u8] = include_bytes!("fixture_data/demo-v2.webm");
const CHIME: &[u8] = include_bytes!("fixture_data/chime.opus");

const GRACE: (&str, &str) = ("Grace Hopper", "grace@example.com");

/// The fixtures `gitbolt-harness fixture` builds from here.
pub const NAMES: [&str; 3] = ["previews", "submodules", "lfs"];

/// Builds the showcase fixture `name` into `r`; `false` if it isn't one of `NAMES`.
pub fn build(name: &str, r: &TestRepo) -> bool {
    match name {
        "previews" => previews(r),
        "submodules" => submodules(r),
        "lfs" => lfs(r),
        _ => return false,
    }
    true
}

pub fn previews(r: &TestRepo) {
    r.write("README.md", "# Gallery\n\nSample files for GitBolt's previews: open a commit and pick a file.\n");
    r.write_bytes("images/scene.png", &scene_png(false));
    r.write("images/logo.svg", &logo_svg(false));
    r.write_bytes("audio/tone.wav", &wav(&[(440.0, 0.9)]));
    r.write_bytes("audio/chime.opus", CHIME);
    r.write_bytes("media/demo.webm", DEMO_V1);
    r.write_bytes("fonts/BoltPixel.ttf", &pixel_font(false));
    r.write_bytes("docs/timetable.pdf", &timetable_pdf(false));
    r.write("site/index.html", &site_html(false));
    r.write("site/style.css", &site_css(false));
    r.write_bytes("site/hero.png", &hero_png());
    r.write("site/widgets.html", WIDGETS_HTML);
    r.write("data/stations.csv", STATIONS_V1);
    r.write("data/inventory.tsv", INVENTORY_V1);
    r.write("notes/release-notes.md", RELEASE_NOTES_V1);
    r.write("scripts/deploy.sh", "#!/bin/sh\n# Copies the site to the (made-up) staging host.\nset -eu\nrsync -a site/ staging.example.invalid:/srv/gallery/\n");
    // Executable on disk (`add -A` reads the mode from there), and in the index where git
    // ignores the file mode.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(r.path().join("scripts/deploy.sh"), std::fs::Permissions::from_mode(0o755)).expect("chmod the script");
    }
    r.git(&["update-index", "--add", "--chmod=+x", "scripts/deploy.sh"]);
    r.commit_all_as("Add the gallery", "Ada Lovelace", "ada@example.com");

    r.write_bytes("images/scene.png", &scene_png(true));
    r.write("images/logo.svg", &logo_svg(true));
    r.write_bytes("audio/tone.wav", &wav(&[(523.25, 0.3), (659.25, 0.3), (783.99, 0.6)]));
    r.write_bytes("media/demo.webm", DEMO_V2);
    r.write_bytes("fonts/BoltPixel.ttf", &pixel_font(true));
    r.write_bytes("docs/timetable.pdf", &timetable_pdf(true));
    r.write("site/index.html", &site_html(true));
    r.write("site/style.css", &site_css(true));
    r.write("data/stations.csv", STATIONS_V2);
    r.write("data/inventory.tsv", INVENTORY_V2);
    r.write("notes/release-notes.md", RELEASE_NOTES_V2);
    r.commit_all_as("Refresh the gallery", GRACE.0, GRACE.1);
}

/// git refuses a local submodule URL unless `protocol.file.allow=always`.
const FILE_OK: [&str; 2] = ["-c", "protocol.file.allow=always"];

pub fn submodules(r: &TestRepo) {
    let source = |name: &str| {
        let dir = r.root().join(name);
        r.git_in(r.root(), &["init", "-q", "-b", "main", name]);
        dir
    };
    let add = |dir: &std::path::Path, file: &str, text: &str, subject: &str| {
        std::fs::write(dir.join(file), text).expect("write source file");
        r.git_in(dir, &["add", "-A"]);
        r.git_in(dir, &["commit", "-q", "-m", subject]);
    };
    let parser = source("parser-src");
    add(&parser, "parser.txt", "read the header\n", "Start the parser");
    add(&parser, "header.txt", "magic, version, length\n", "Parse the header");
    let theme = source("theme-src");
    add(&theme, "colors.txt", "background #1e2229\n", "Dark theme");

    r.write("README.md", "# Atlas\n\nA made-up app with its parser and theme as submodules.\n");
    r.commit_all_as("Initial commit", "Ada Lovelace", "ada@example.com");
    for (src, path) in [(&parser, "libs/parser"), (&theme, "libs/theme")] {
        let url = format!("file://{}", std::path::absolute(src).expect("absolute source path").display());
        r.git(&[FILE_OK[0], FILE_OK[1], "submodule", "add", "-q", &url, path]);
    }
    r.git(&["commit", "-q", "-m", "Add the parser and theme submodules"]);

    // A commit that moves the parser's pointer: its diff names both commits.
    let sub = r.path().join("libs/parser");
    add(&parser, "body.txt", "sections, then records\n", "Parse the body");
    r.git_in(&sub, &[FILE_OK[0], FILE_OK[1], "fetch", "-q", "origin"]);
    r.git_in(&sub, &["checkout", "-q", "--detach", "origin/main"]);
    r.git(&["add", "libs/parser"]);
    r.git(&["commit", "-q", "--author", &format!("{} <{}>", GRACE.0, GRACE.1), "-m", "Update the parser to Parse the body"]);

    // The working copy: the parser checked out past the recorded commit, with an edited file.
    add(&parser, "footer.txt", "checksum\n", "Parse the footer");
    r.git_in(&sub, &[FILE_OK[0], FILE_OK[1], "fetch", "-q", "origin"]);
    r.git_in(&sub, &["checkout", "-q", "--detach", "origin/main"]);
    std::fs::write(sub.join("parser.txt"), "read the header\nskip the padding\n").expect("edit the parser");

    // The theme: recorded, but never initialised here.
    r.git(&["submodule", "deinit", "-q", "-f", "libs/theme"]);
    std::fs::remove_dir_all(r.path().join(".git/modules/libs/theme")).expect("remove the theme's clone");
}

pub fn lfs(r: &TestRepo) {
    r.write(".gitattributes", "*.png filter=lfs diff=lfs merge=lfs -text\n*.psd filter=lfs diff=lfs merge=lfs -text\n");
    r.write("README.md", "# Poster\n\nArt for a made-up concert poster, stored with Git LFS.\n");
    r.write("art/cover.png", &lfs_store(r, &poster_png(false)));
    // Never downloaded here: only its pointer exists.
    r.write("art/layers.psd", &lfs_pointer(&fake_psd(1)));
    r.commit_all_as("Track art with Git LFS", "Ada Lovelace", "ada@example.com");

    r.write("art/cover.png", &lfs_store(r, &poster_png(true)));
    r.write("art/layers.psd", &lfs_pointer(&fake_psd(2)));
    r.write("README.md", "# Poster\n\nArt for a made-up concert poster, stored with Git LFS.\n\nThe cover is now the evening version.\n");
    r.commit_all_as("Switch the cover to the evening version", GRACE.0, GRACE.1);
}

/// `bytes`' LFS pointer.
fn lfs_pointer(bytes: &[u8]) -> String {
    let oid: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    format!("version https://git-lfs.github.com/spec/v1\noid sha256:{oid}\nsize {}\n", bytes.len())
}

/// Puts `bytes` in `r`'s LFS store (`.git/lfs/objects/aa/bb/<oid>`) and returns its pointer.
fn lfs_store(r: &TestRepo, bytes: &[u8]) -> String {
    let oid: String = Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect();
    let path = r.path().join(".git/lfs/objects").join(&oid[..2]).join(&oid[2..4]).join(&oid);
    std::fs::create_dir_all(path.parent().expect("object dir")).expect("create the LFS store");
    std::fs::write(&path, bytes).expect("write the LFS object");
    lfs_pointer(bytes)
}

/// A stand-in for a layered Photoshop file (its bytes are never shown: only the pointer is kept).
fn fake_psd(version: u8) -> Vec<u8> {
    let mut b = b"8BPS".to_vec();
    b.extend((0..300_000u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 24) as u8 ^ version));
    b
}

// --- Images ---

/// An RGB PNG drawn by `f(x, y)`, uncompressed (stored deflate blocks): git compresses it anyway.
fn rgb_png(w: u32, h: u32, f: impl Fn(u32, u32) -> [u8; 3]) -> Vec<u8> {
    fn crc32(bytes: &[u8]) -> u32 {
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
    let mut raw = Vec::with_capacity(((3 * w + 1) * h) as usize);
    for y in 0..h {
        raw.push(0);
        for x in 0..w {
            raw.extend_from_slice(&f(x, y));
        }
    }
    let (mut a, mut b) = (1u32, 0u32);
    for &x in &raw {
        a = (a + x as u32) % 65521;
        b = (b + a) % 65521;
    }
    let mut zlib = vec![0x78, 0x01];
    let blocks: Vec<&[u8]> = raw.chunks(0xFFFF).collect();
    for (i, block) in blocks.iter().enumerate() {
        zlib.push(u8::from(i + 1 == blocks.len()));
        let len = block.len() as u16;
        zlib.extend_from_slice(&len.to_le_bytes());
        zlib.extend_from_slice(&(!len).to_le_bytes());
        zlib.extend_from_slice(block);
    }
    zlib.extend_from_slice(&((b << 16) | a).to_be_bytes());
    let mut ihdr = Vec::new();
    ihdr.extend_from_slice(&w.to_be_bytes());
    ihdr.extend_from_slice(&h.to_be_bytes());
    ihdr.extend_from_slice(&[8, 2, 0, 0, 0]); // 8-bit RGB, deflate, no filter, no interlace
    let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
    chunk(&mut png, b"IHDR", &ihdr);
    chunk(&mut png, b"IDAT", &zlib);
    chunk(&mut png, b"IEND", &[]);
    png
}

fn mix(a: [f32; 3], b: [f32; 3], t: f32) -> [f32; 3] {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

fn rgb(c: [f32; 3]) -> [u8; 3] {
    c.map(|v| v.clamp(0.0, 255.0) as u8)
}

/// Hills under a sky with a sun (`night`: a moon, stars and darker colours). 192×120.
fn scene_png(night: bool) -> Vec<u8> {
    let (w, h) = (192u32, 120u32);
    rgb_png(w, h, |x, y| {
        let (u, v) = (x as f32 / w as f32, y as f32 / h as f32);
        let (top, horizon) = if night { ([12.0, 18.0, 48.0], [52.0, 40.0, 96.0]) } else { ([90.0, 160.0, 230.0], [250.0, 200.0, 150.0]) };
        let mut c = mix(top, horizon, v);
        let (sx, sy, sr) = if night { (0.25, 0.25, 0.08) } else { (0.7, 0.42, 0.12) };
        if ((u - sx) * 1.6).hypot(v - sy) < sr {
            c = if night { [235.0, 235.0, 210.0] } else { [255.0, 190.0, 60.0] };
        }
        if night && (x * 7 + y * 13) % 97 == 0 && v < 0.5 {
            c = [255.0, 255.0, 255.0];
        }
        let far = 0.62 + 0.08 * (u * 9.0).sin();
        let near = 0.75 + 0.06 * (u * 5.0 + 1.0).cos();
        if v > near {
            c = if night { [18.0, 40.0, 30.0] } else { [60.0, 130.0, 70.0] };
        } else if v > far {
            c = if night { [30.0, 55.0, 50.0] } else { [100.0, 160.0, 110.0] };
        }
        rgb(c)
    })
}

/// The site's header image: a lighthouse beam over the sea. 240×80.
fn hero_png() -> Vec<u8> {
    let (w, h) = (240u32, 80u32);
    rgb_png(w, h, |x, y| {
        let (u, v) = (x as f32 / w as f32, y as f32 / h as f32);
        let mut c = mix([20.0, 30.0, 60.0], [70.0, 90.0, 140.0], v);
        if v > 0.7 {
            c = mix([20.0, 60.0, 90.0], [10.0, 30.0, 50.0], (v - 0.7) / 0.3);
        }
        let beam = (v - 0.3) - (u - 0.15) * 0.25;
        if u > 0.15 && beam.abs() < 0.04 + (u - 0.15) * 0.12 {
            c = mix(c, [255.0, 240.0, 170.0], 0.6);
        }
        if (u - 0.15).abs() < 0.02 && v > 0.3 && v < 0.75 {
            c = if ((v * 20.0) as u32).is_multiple_of(2) { [230.0, 60.0, 50.0] } else { [240.0, 240.0, 240.0] };
        }
        rgb(c)
    })
}

/// The LFS cover: a concert poster's sunburst (`evening`: violet and pink). 200×280.
fn poster_png(evening: bool) -> Vec<u8> {
    let (w, h) = (200u32, 280u32);
    rgb_png(w, h, |x, y| {
        let (dx, dy) = (x as f32 - 100.0, y as f32 - 150.0);
        let ray = ((dy.atan2(dx) * 12.0 / std::f32::consts::PI).floor() as i32).rem_euclid(2) == 0;
        let (a, b, disc) = if evening { ([70.0, 30.0, 110.0], [140.0, 50.0, 120.0], [255.0, 120.0, 170.0]) } else { ([240.0, 170.0, 40.0], [250.0, 210.0, 90.0], [220.0, 60.0, 40.0]) };
        let mut c = if ray { a } else { b };
        if dx.hypot(dy) < 45.0 {
            c = disc;
        }
        if y > 230 {
            c = [25.0, 25.0, 30.0];
        }
        rgb(c)
    })
}

fn logo_svg(round: bool) -> String {
    let shape = if round { r##"<circle cx="64" cy="64" r="60" fill="#2f6fde"/>"## } else { r##"<rect x="4" y="4" width="120" height="120" rx="12" fill="#1f2937"/>"## };
    let bolt = if round { "#ffd23f" } else { "#f25d2e" };
    format!("<svg xmlns=\"http://www.w3.org/2000/svg\" width=\"128\" height=\"128\" viewBox=\"0 0 128 128\">\n  {shape}\n  <path d=\"M72 14 L34 72 H60 L52 114 L94 52 H67 Z\" fill=\"{bolt}\"/>\n</svg>\n")
}

// --- Audio ---

/// A 16-bit mono 8 kHz WAV of sine `notes` (frequency, seconds), each faded in and out.
fn wav(notes: &[(f32, f32)]) -> Vec<u8> {
    const RATE: u32 = 8000;
    let mut samples: Vec<i16> = Vec::new();
    for &(freq, secs) in notes {
        let n = (secs * RATE as f32) as usize;
        for i in 0..n {
            let t = i as f32 / RATE as f32;
            let env = (i.min(n - i) as f32 / 400.0).min(1.0);
            samples.push(((t * freq * std::f32::consts::TAU).sin() * env * 12_000.0) as i16);
        }
    }
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&1u16.to_le_bytes()); // mono
    out.extend_from_slice(&RATE.to_le_bytes());
    out.extend_from_slice(&(RATE * 2).to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for s in samples {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

// --- PDF ---

/// A ferry timetable, written by hand: one page, then (`v2`) a new title, changed times and a
/// second page. Plain ASCII with a correct xref table.
fn timetable_pdf(v2: bool) -> Vec<u8> {
    let page1 = if v2 {
        "BT /F1 26 Tf 72 700 Td (Port Wren Ferry: Summer) Tj ET BT /F1 14 Tf 72 660 Td (Departs 07:15, 09:45, 12:30, 16:00, 19:20) Tj ET 0.18 0.44 0.87 rg 72 420 468 160 re f 1 1 1 rg BT /F1 18 Tf 96 490 Td (Extra sailings on weekends) Tj ET"
    } else {
        "BT /F1 26 Tf 72 700 Td (Port Wren Ferry) Tj ET BT /F1 14 Tf 72 660 Td (Departs 07:30, 10:00, 13:00, 17:30) Tj ET 0.95 0.36 0.18 rg 72 420 468 160 re f"
    };
    let mut pages = vec![page1.to_string()];
    if v2 {
        pages.push("BT /F1 22 Tf 72 700 Td (Fares) Tj ET BT /F1 14 Tf 72 660 Td (Adult 6.50, Child 3.25, Bicycle 2.00) Tj ET 0.2 0.6 0.35 rg 72 300 200 200 re f".into());
    }
    let n = pages.len();
    let kids: Vec<String> = (0..n).map(|i| format!("{} 0 R", 4 + 2 * i)).collect();
    let mut objects = vec![
        "<< /Type /Catalog /Pages 2 0 R >>".to_string(),
        format!("<< /Type /Pages /Kids [{}] /Count {n} >>", kids.join(" ")),
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>".to_string(),
    ];
    for (i, content) in pages.iter().enumerate() {
        objects.push(format!("<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents {} 0 R >>", 5 + 2 * i));
        objects.push(format!("<< /Length {} >>\nstream\n{content}\nendstream", content.len()));
    }
    let mut pdf = String::from("%PDF-1.4\n");
    let mut offsets = Vec::new();
    for (i, o) in objects.iter().enumerate() {
        offsets.push(pdf.len());
        pdf += &format!("{} 0 obj\n{o}\nendobj\n", i + 1);
    }
    let xref = pdf.len();
    pdf += &format!("xref\n0 {}\n0000000000 65535 f \n", objects.len() + 1);
    for o in offsets {
        pdf += &format!("{o:010} 00000 n \n");
    }
    pdf += &format!("trailer\n<< /Size {} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF\n", objects.len() + 1);
    pdf.into_bytes()
}

// --- HTML, tables, Markdown ---

fn site_html(v2: bool) -> String {
    let (title, lead, button) = if v2 {
        ("Harbour Lights Gallery", "Photographs of the coast after dark, every Friday until September.", "Plan your visit")
    } else {
        ("Harbour Lights", "Photographs of the coast, open on weekends.", "Opening hours")
    };
    let extra = if v2 { "\n      <li>Night walk, Fridays at 21:00</li>" } else { "" };
    format!(
        "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <title>{title}</title>\n  <link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n  <header>\n    <img src=\"hero.png\" alt=\"A lighthouse beam over the sea\">\n    <h1>{title}</h1>\n  </header>\n  <main>\n    <p class=\"lead\">{lead}</p>\n    <ul>\n      <li>Main hall: the harbour at dawn</li>\n      <li>East room: fishing boats</li>{extra}\n    </ul>\n    <a class=\"button\" href=\"#hours\">{button}</a>\n  </main>\n</body>\n</html>\n"
    )
}

fn site_css(v2: bool) -> String {
    let (bg, accent) = if v2 { ("#0f172a", "#ffd23f") } else { ("#f8fafc", "#f25d2e") };
    let fg = if v2 { "#e2e8f0" } else { "#1f2937" };
    format!(
        "body {{ margin: 0; font-family: system-ui, sans-serif; background: {bg}; color: {fg}; }}\nheader img {{ display: block; width: 100%; height: 160px; object-fit: cover; }}\nh1 {{ margin: 16px 24px 0; color: {accent}; }}\nmain {{ padding: 8px 24px 24px; }}\n.lead {{ font-size: 1.15rem; }}\n.button {{ display: inline-block; padding: 8px 16px; border-radius: 6px; background: {accent}; color: #111; text-decoration: none; }}\n"
    )
}

const WIDGETS_HTML: &str = r#"<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Visitor numbers</title>
  <link rel="stylesheet" href="style.css">
  <script src="https://cdn.example.net/charts@4.2.0/charts.min.js"></script>
</head>
<body>
  <main>
    <h1>Visitor numbers</h1>
    <p>The chart below is drawn by a script from a CDN, which the preview doesn't load.</p>
    <canvas id="visitors" width="480" height="200"></canvas>
    <script>Charts.line('#visitors', [120, 180, 150, 220, 260]);</script>
  </main>
</body>
</html>
"#;

const STATIONS_V1: &str = "id,name,region,elevation_m,active\nST01,Port Wren,Coast,4,yes\nST02,Hollow Ridge,Highlands,812,yes\nST03,Millbrook,Valley,145,yes\nST04,Cape Lantern,Coast,22,no\nST05,Ashford Moor,Highlands,603,yes\nST06,Kettle Bay,Coast,9,yes\n";
const STATIONS_V2: &str = "id,name,region,elevation_m,active\nST01,Port Wren,Coast,4,yes\nST02,Hollow Ridge,Highlands,815,yes\nST03,Millbrook,Valley,145,yes\nST05,Ashford Moor,Highlands,603,no\nST06,Kettle Bay,Coast,9,yes\nST07,Fernside,Valley,98,yes\nST08,North Spit,Coast,3,yes\n";

const INVENTORY_V1: &str = "sku\titem\tqty\tshelf\nA-100\tLantern\t12\tA1\nA-101\tRope, 10 m\t30\tA2\nB-200\tTide chart\t45\tB1\nB-201\tCompass\t8\tB1\nC-300\tOilskin coat\t5\tC3\n";
const INVENTORY_V2: &str = "sku\titem\tqty\tshelf\nA-100\tLantern\t9\tA1\nA-101\tRope, 10 m\t30\tA2\nB-200\tTide chart\t45\tB1\nC-300\tOilskin coat\t7\tC2\nC-301\tSou'wester hat\t14\tC2\n";

const RELEASE_NOTES_V1: &str = "---\ntitle: Gallery release notes\nversion: 1.0\ndate: 2026-03-02\ntags: [gallery, spring]\ndraft: true\n---\n\n# Gallery 1.0\n\nThe first hang of the **Harbour Lights** collection.\n\n- Twelve photographs of the harbour\n- A printed ferry timetable\n\n> Opening night is Saturday.\n";
const RELEASE_NOTES_V2: &str = "---\ntitle: Gallery release notes\nversion: 1.1\ndate: 2026-06-14\ntags: [gallery, summer, night]\ndraft: false\n---\n\n# Gallery 1.1\n\nThe summer hang of the **Harbour Lights** collection.\n\n- Twelve photographs of the harbour\n- Six new night photographs\n- The summer ferry timetable, with fares\n\n| Room | Theme |\n| --- | --- |\n| Main hall | The harbour at dawn |\n| East room | After dark |\n\n> Night walks start on Friday.\n";

// --- A TrueType font, generated ---

/// 5×7 pixel glyphs, top row first; lowercase letters use the capitals.
const PIXEL_GLYPHS: &[(char, [&str; 7])] = &[
    ('A', [".###.", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"]),
    ('B', ["####.", "#...#", "#...#", "####.", "#...#", "#...#", "####."]),
    ('C', [".###.", "#...#", "#....", "#....", "#....", "#...#", ".###."]),
    ('D', ["####.", "#...#", "#...#", "#...#", "#...#", "#...#", "####."]),
    ('E', ["#####", "#....", "#....", "####.", "#....", "#....", "#####"]),
    ('F', ["#####", "#....", "#....", "####.", "#....", "#....", "#...."]),
    ('G', [".###.", "#...#", "#....", "#.###", "#...#", "#...#", ".####"]),
    ('H', ["#...#", "#...#", "#...#", "#####", "#...#", "#...#", "#...#"]),
    ('I', [".###.", "..#..", "..#..", "..#..", "..#..", "..#..", ".###."]),
    ('J', ["..###", "...#.", "...#.", "...#.", "...#.", "#..#.", ".##.."]),
    ('K', ["#...#", "#..#.", "#.#..", "##...", "#.#..", "#..#.", "#...#"]),
    ('L', ["#....", "#....", "#....", "#....", "#....", "#....", "#####"]),
    ('M', ["#...#", "##.##", "#.#.#", "#.#.#", "#...#", "#...#", "#...#"]),
    ('N', ["#...#", "#...#", "##..#", "#.#.#", "#..##", "#...#", "#...#"]),
    ('O', [".###.", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."]),
    ('P', ["####.", "#...#", "#...#", "####.", "#....", "#....", "#...."]),
    ('Q', [".###.", "#...#", "#...#", "#...#", "#.#.#", "#..#.", ".##.#"]),
    ('R', ["####.", "#...#", "#...#", "####.", "#.#..", "#..#.", "#...#"]),
    ('S', [".####", "#....", "#....", ".###.", "....#", "....#", "####."]),
    ('T', ["#####", "..#..", "..#..", "..#..", "..#..", "..#..", "..#.."]),
    ('U', ["#...#", "#...#", "#...#", "#...#", "#...#", "#...#", ".###."]),
    ('V', ["#...#", "#...#", "#...#", "#...#", "#...#", ".#.#.", "..#.."]),
    ('W', ["#...#", "#...#", "#...#", "#.#.#", "#.#.#", "#.#.#", ".#.#."]),
    ('X', ["#...#", "#...#", ".#.#.", "..#..", ".#.#.", "#...#", "#...#"]),
    ('Y', ["#...#", "#...#", ".#.#.", "..#..", "..#..", "..#..", "..#.."]),
    ('Z', ["#####", "....#", "...#.", "..#..", ".#...", "#....", "#####"]),
    ('0', [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."]),
    ('1', ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."]),
    ('2', [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"]),
    ('3', ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."]),
    ('4', ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."]),
    ('5', ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."]),
    ('6', ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."]),
    ('7', ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."]),
    ('8', [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."]),
    ('9', [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."]),
    ('.', [".....", ".....", ".....", ".....", ".....", ".##..", ".##.."]),
    (',', [".....", ".....", ".....", ".....", ".##..", "..#..", ".#..."]),
    ('!', ["..#..", "..#..", "..#..", "..#..", "..#..", ".....", "..#.."]),
    ('?', [".###.", "#...#", "....#", "...#.", "..#..", ".....", "..#.."]),
    ('-', [".....", ".....", ".....", "#####", ".....", ".....", "....."]),
    (':', [".....", ".##..", ".##..", ".....", ".##..", ".##..", "....."]),
    ('\'', ["..#..", "..#..", ".#...", ".....", ".....", ".....", "....."]),
    ('"', [".#.#.", ".#.#.", ".....", ".....", ".....", ".....", "....."]),
    ('(', ["...#.", "..#..", ".#...", ".#...", ".#...", "..#..", "...#."]),
    (')', [".#...", "..#..", "...#.", "...#.", "...#.", "..#..", ".#..."]),
    ('/', [".....", "....#", "...#.", "..#..", ".#...", "#....", "....."]),
    ('+', [".....", "..#..", "..#..", "#####", "..#..", "..#..", "....."]),
    ('=', [".....", ".....", "#####", ".....", "#####", ".....", "....."]),
    ('#', [".#.#.", ".#.#.", "#####", ".#.#.", "#####", ".#.#.", ".#.#."]),
    ('&', [".##..", "#..#.", "#.#..", ".#...", "#.#.#", "#..#.", ".##.#"]),
    ('_', [".....", ".....", ".....", ".....", ".....", ".....", "#####"]),
];

/// "Bolt Pixel", a monospaced TrueType font of square pixels (`dots`: round-ish dots, style
/// "Dots", version 2.0): every glyph is drawn from `PIXEL_GLYPHS`, one contour per pixel.
fn pixel_font(dots: bool) -> Vec<u8> {
    const UNIT: i16 = 100;
    const ADVANCE: u16 = 600;
    let inset: i16 = if dots { 14 } else { 0 };
    // Glyph 0 .notdef (a hollow box), 1 space, then PIXEL_GLYPHS in order.
    let mut contours: Vec<Vec<Vec<(i16, i16)>>> = vec![
        vec![vec![(50, 0), (50, 700), (450, 700), (450, 0)], vec![(100, 50), (400, 50), (400, 650), (100, 650)]],
        vec![],
    ];
    for (_, rows) in PIXEL_GLYPHS {
        let mut glyph = Vec::new();
        for (row, line) in rows.iter().enumerate() {
            for (col, px) in line.bytes().enumerate() {
                if px != b'#' {
                    continue;
                }
                let (x0, y1) = (50 + col as i16 * UNIT + inset, (7 - row as i16) * UNIT - inset);
                let (x1, y0) = (50 + (col as i16 + 1) * UNIT - inset, (6 - row as i16) * UNIT + inset);
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
    head.extend_from_slice(&(if dots { 0x0002_0000u32 } else { 0x0001_0000 }).to_be_bytes());
    head.extend_from_slice(&0u32.to_be_bytes()); // checkSumAdjustment, set last
    head.extend_from_slice(&0x5F0F_3CF5u32.to_be_bytes());
    be16(&mut head, &[0x000B, 1000]);
    head.extend_from_slice(&3_850_000_000i64.to_be_bytes()); // created, 2025 (seconds since 1904)
    head.extend_from_slice(&3_850_000_000i64.to_be_bytes()); // modified
    for v in [0i16, 0, 550, 700] {
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

    let mut os2 = Vec::new();
    be16(&mut os2, &[4, ADVANCE, 400, 5, 0]);
    for v in [650i16, 600, 0, 75, 650, 600, 0, 350, 50, 300, 0] {
        os2.extend_from_slice(&v.to_be_bytes()); // sub/superscript sizes and offsets, strikeout, family class
    }
    os2.extend_from_slice(&[2, 11, 6, 9, 0, 0, 0, 0, 0, 0]); // panose
    for v in [1u32, 0, 0, 0] {
        os2.extend_from_slice(&v.to_be_bytes()); // Basic Latin
    }
    os2.extend_from_slice(b"GBLT");
    be16(&mut os2, &[0x0040, 0x20, 0x7E]);
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
    for (i, (c, _)) in PIXEL_GLYPHS.iter().enumerate() {
        let gid = 2 + i as u16;
        chars.push((*c as u16, gid));
        if c.is_ascii_uppercase() {
            chars.push((c.to_ascii_lowercase() as u16, gid));
        }
    }
    chars.sort();
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

    let style = if dots { "Dots" } else { "Regular" };
    let version = if dots { "Version 2.000" } else { "Version 1.000" };
    let names = [
        (0u16, "Made up for GitBolt's test fixtures. Public domain.".to_string()),
        (1, "Bolt Pixel".into()),
        (2, style.into()),
        (3, format!("Bolt Pixel {style} {version}")),
        (4, format!("Bolt Pixel {style}")),
        (5, version.into()),
        (6, format!("BoltPixel-{style}")),
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

    fn files_at(r: &TestRepo, rev: &str) -> Vec<String> {
        r.git(&["ls-tree", "-r", "--name-only", rev]).lines().map(String::from).collect()
    }

    #[test]
    fn previews_changes_every_kind_of_file_and_stays_small() {
        let r = TestRepo::new();
        previews(&r);
        assert_eq!(r.git(&["log", "--format=%s"]), "Refresh the gallery\nAdd the gallery");
        let changed = r.git(&["diff", "--name-only", "HEAD~1", "HEAD"]);
        for f in ["images/scene.png", "images/logo.svg", "audio/tone.wav", "media/demo.webm", "fonts/BoltPixel.ttf", "docs/timetable.pdf", "site/index.html", "site/style.css", "data/stations.csv", "data/inventory.tsv", "notes/release-notes.md"] {
            assert!(changed.lines().any(|l| l == f), "{f} changes in the second commit");
        }
        let all = files_at(&r, "HEAD");
        for f in ["audio/chime.opus", "site/hero.png", "site/widgets.html", "scripts/deploy.sh", "README.md"] {
            assert!(all.contains(&f.to_string()), "{f} is at HEAD");
        }
        assert!(r.git(&["ls-files", "-s", "scripts/deploy.sh"]).starts_with("100755"), "the script is executable");
        assert!(r.git(&["status", "--porcelain"]).is_empty());
        let size: u64 = r.git(&["count-objects", "-v"]).lines().find_map(|l| l.strip_prefix("size: ")).unwrap().parse().unwrap();
        assert!(size < 1024, "the repository stays under 1 MB: {size} KiB");
        let pdf = std::fs::read(r.path().join("docs/timetable.pdf")).unwrap();
        assert!(pdf.starts_with(b"%PDF-1.4") && String::from_utf8_lossy(&pdf).contains("/Count 2"));
        let png = std::fs::read(r.path().join("images/scene.png")).unwrap();
        assert_eq!(&png[1..4], b"PNG");
    }

    #[test]
    fn the_font_is_a_well_formed_truetype_file() {
        let font = pixel_font(false);
        assert_eq!(&font[..4], &[0, 1, 0, 0]);
        assert_eq!(font.len() % 4, 0);
        let n = u16::from_be_bytes([font[4], font[5]]) as usize;
        let tags: Vec<&[u8]> = (0..n).map(|i| &font[12 + 16 * i..16 + 16 * i]).collect();
        assert!(tags.windows(2).all(|w| w[0] < w[1]), "the table directory is sorted");
        let sum = font.chunks(4).fold(0u32, |s, c| s.wrapping_add(u32::from_be_bytes(c.try_into().unwrap())));
        assert_eq!(sum, 0xB1B0_AFBA, "head's checkSumAdjustment balances the file");
        let text = String::from_utf8_lossy(&pixel_font(true)).replace('\0', "");
        assert!(text.contains("Bolt Pixel") && text.contains("Dots"));
    }

    #[test]
    fn submodules_has_a_moved_pointer_a_dirty_checkout_and_an_uninitialised_one() {
        let r = TestRepo::new();
        submodules(&r);
        let status = r.git(&["submodule", "status"]);
        assert!(status.lines().any(|l| l.starts_with('+') && l.contains("libs/parser")), "{status}");
        assert!(status.lines().any(|l| l.starts_with('-') && l.contains("libs/theme")), "{status}");
        let sub = r.path().join("libs/parser");
        assert_eq!(r.git_in(&sub, &["log", "-1", "--format=%s"]), "Parse the footer");
        assert!(!r.git_in(&sub, &["status", "--porcelain"]).is_empty(), "the parser has an edited file");
        let moved = r.git(&["show", "--format=%s", "--submodule=log", "HEAD"]);
        assert!(moved.starts_with("Update the parser to Parse the body") && moved.contains("Parse the body"), "{moved}");
        assert!(r.git(&["config", "-f", ".gitmodules", "submodule.libs/parser.url"]).starts_with("file://"));
    }

    #[test]
    fn lfs_has_stored_and_missing_objects() {
        let r = TestRepo::new();
        lfs(&r);
        let pointer = |rev: &str, path: &str| gitbolt_core::lfs::parse_pointer(r.git(&["show", &format!("{rev}:{path}")]).as_bytes()).expect("a pointer");
        let store = r.path().join(".git/lfs");
        for rev in ["HEAD", "HEAD~1"] {
            let cover = pointer(rev, "art/cover.png");
            let object = gitbolt_core::lfs::object_path(&store, &cover.oid);
            assert_eq!(std::fs::metadata(&object).map(|m| m.len()).ok(), Some(cover.size), "{rev}'s cover is downloaded");
            let psd = pointer(rev, "art/layers.psd");
            assert!(!gitbolt_core::lfs::object_path(&store, &psd.oid).exists(), "{rev}'s layers aren't");
        }
        assert_ne!(pointer("HEAD", "art/cover.png"), pointer("HEAD~1", "art/cover.png"));
        assert_eq!(r.git(&["check-attr", "filter", "art/cover.png"]), "art/cover.png: filter: lfs");
        assert!(r.git(&["status", "--porcelain"]).is_empty());
    }
}
