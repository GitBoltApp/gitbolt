//! The playground's media repositories: `previews` (every kind of file the diff and File View
//! preview), `submodules` (a moved pointer, a dirty checkout, an uninitialised one) and `lfs`
//! (Git LFS without git-lfs). The media are Orbital's own: `orbital::assets` and `media`.

use super::Play;
use crate::media::{encoded, svg};
use crate::orbital::{art, assets, data, design_doc, glyphs, scenes};
use gitbolt_core::testing::TestRepo;
use sha2::{Digest, Sha256};
use std::path::Path;

const PRESS_README: &str = "# Orbital press kit\n\nLogos, screenshots, audio, a trailer and the press page for Orbital. Open a commit and pick a file to see how GitBolt previews it.\n";
const PRESS_HTML_V1: &str = "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <title>Orbital press page</title>\n  <link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n  <h1>Orbital</h1>\n  <p>A small space-trading game about orbits, cargo and bad decisions.</p>\n  <img src=\"hero.png\" alt=\"The scout in orbit\" width=\"640\">\n</body>\n</html>\n";
const PRESS_HTML_V2: &str = "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <title>Orbital press page</title>\n  <link rel=\"stylesheet\" href=\"style.css\">\n</head>\n<body>\n  <h1>Orbital 1.1 is out</h1>\n  <p>Fly cargo between stations without running out of fuel.</p>\n  <img src=\"hero.png\" alt=\"The scout in orbit\" width=\"640\">\n  <h2>What's new in 1.1</h2>\n  <ul>\n    <li>Docking assist</li>\n    <li>Three new stations</li>\n    <li>A rebuilt trading screen</li>\n  </ul>\n</body>\n</html>\n";
const PRESS_CSS_V1: &str = "body { margin: 0; padding: 32px; background: #1a2238; color: #e6ecf5; font: 16px/1.5 system-ui, sans-serif; }\nh1 { color: #ffc95e; letter-spacing: 0.08em; }\nimg { image-rendering: pixelated; border: 2px solid #3cc2ae; }\n";
const PRESS_CSS_V2: &str = "body { margin: 0; padding: 32px; background: #0a0f1e; color: #d4dcea; font: 16px/1.6 system-ui, sans-serif; }\nh1 { color: #ffb23e; letter-spacing: 0.1em; }\nh2 { color: #3cc2ae; }\nli { margin: 4px 0; }\nimg { image-rendering: pixelated; border: 2px solid #ffb23e; }\n";
const LEADERBOARD_HTML: &str = "<!doctype html>\n<html lang=\"en\">\n<head>\n  <meta charset=\"utf-8\">\n  <title>Orbital leaderboard</title>\n  <script src=\"https://cdn.example.net/charts@4.2.0/charts.min.js\"></script>\n</head>\n<body>\n  <h1>Top traders</h1>\n  <canvas id=\"board\" width=\"600\" height=\"300\"></canvas>\n  <script>new Charts.Bar(document.getElementById('board'), { source: 'scores.json' });</script>\n</body>\n</html>\n";
const COMMODITIES_V1: &str = "id,name,base_price,volatility\nwater_ice,Water ice,40,0.10\nfuel_cells,Fuel cells,120,0.15\nrations,Rations,60,0.08\nmachinery,Machinery,310,0.20\nelectronics,Electronics,450,0.25\nore,Raw ore,85,0.12\nmedicine,Medicine,520,0.30\nluxuries,Luxuries,900,0.40\n";
const COMMODITIES_V2: &str = "id,name,base_price,volatility\nwater_ice,Water ice,45,0.10\nfuel_cells,Fuel cells,120,0.15\nrations,Rations,60,0.08\nmachinery,Machinery,290,0.20\nelectronics,Electronics,450,0.25\nore,Raw ore,85,0.12\nluxuries,Luxuries,900,0.40\nsalvage,Salvage,150,0.35\nartifacts,Artifacts,1400,0.50\n";
const STATIONS_V1: &str = "id\tname\tregion\tdock_bays\nST01\tRing One\tInner\t12\nST02\tDepot Alpha\tInner\t8\nST03\tOutpost Kite\tBelt\t3\nST04\tRelay Nine\tBelt\t4\nST05\tHarbor Deep\tOuter\t6\n";
const STATIONS_V2: &str = "id\tname\tregion\tdock_bays\nST01\tRing One\tInner\t14\nST02\tDepot Alpha\tInner\t8\nST03\tOutpost Kite\tBelt\t3\nST05\tHarbor Deep\tOuter\t6\nST06\tCinder Gate\tOuter\t5\nST07\tLantern\tBelt\t2\n";
const DEVLOG_V1: &str = "---\ntitle: Flying the scout\ndate: 2026-05-02\nauthor: Noor Achterberg\ntags: [devlog, art]\ndraft: true\n---\n\n# Flying the scout\n\nThe scout finally has a flame.\n\n![The scout](../images/scout.png)\n";
const DEVLOG_V2: &str = "---\ntitle: Flying the scout\ndate: 2026-07-18\nauthor: Noor Achterberg\ntags: [devlog, art, release]\ndraft: false\n---\n\n# Flying the scout\n\nThe scout finally has a flame, and 1.1 gives it a repaint. The hull is cleaner, the cockpit is brighter and the thruster has four frames instead of two.\n\n![The scout](../images/scout.png)\n\n| Ship | Hull | Cargo |\n|---|---|---|\n| Scout | 40 | 2 t |\n| Hauler | 120 | 24 t |\n| Interceptor | 60 | 1 t |\n\nNext up: the stations.\n";
const PACK_SH: &str = "#!/bin/sh\n# Zips the press kit for the website's download link.\nset -eu\nzip -qr orbital-press-kit.zip images audio media docs\n";

pub fn previews(r: &TestRepo) {
    let png = |c: crate::media::canvas::Canvas| c.to_png();
    let mut p = Play::new(r, 2026, 5, 4, 10);
    p.write("README.md", PRESS_README);
    p.write_bytes("images/scout.png", &png(art::ship("scout", 1).scaled(4)));
    p.write_bytes("images/title.png", &png(scenes::title(1)));
    p.write_bytes("images/thruster.gif", &assets::bytes("docs/devlog/img/thruster.gif", 1));
    p.write_bytes("images/orbital.ico", &assets::bytes("crates/orbital-game/assets/orbital.ico", 1));
    p.write("images/fuel.svg", &svg::from_canvas(&art::icon("fuel", 1), 8));
    p.write_bytes("audio/laser.wav", &assets::bytes("assets/audio/sfx/laser.wav", 1));
    p.write_bytes("audio/menu-loop.ogg", encoded::MENU_LOOP);
    p.write_bytes("audio/docking-chime.opus", encoded::DOCKING_CHIME);
    p.write_bytes("media/trailer.webm", encoded::TRAILER_V1);
    p.write_bytes("fonts/OrbitalHud.ttf", &glyphs::hud_font(1));
    p.write_bytes("docs/design.pdf", &design_doc::pdf(1));
    p.write("site/index.html", PRESS_HTML_V1);
    p.write("site/style.css", PRESS_CSS_V1);
    p.write_bytes("site/hero.png", &png(scenes::screenshot("orbit", 1).scaled(2)));
    p.write("site/leaderboard.html", LEADERBOARD_HTML);
    p.write("data/commodities.csv", COMMODITIES_V1);
    p.write("data/stations.tsv", STATIONS_V1);
    p.write("notes/devlog.md", DEVLOG_V1);
    p.write_bytes("saves/slot1.orbsave", &data::orbsave(1));
    p.write("scripts/pack-assets.sh", PACK_SH);
    // Executable on disk (`add -A` reads the mode from there), and in the index where git
    // ignores the file mode.
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(r.path().join("scripts/pack-assets.sh"), std::fs::Permissions::from_mode(0o755)).expect("chmod the script");
    }
    p.git("noor", &["update-index", "--add", "--chmod=+x", "scripts/pack-assets.sh"]);
    p.commit("noor", "Add the press kit");

    p.at(2026, 7, 20, 14, 0);
    p.write_bytes("images/scout.png", &png(art::ship("scout", 2).scaled(4)));
    p.write_bytes("images/title.png", &png(scenes::title(2)));
    p.write_bytes("images/thruster.gif", &assets::bytes("docs/devlog/img/thruster.gif", 2));
    p.write_bytes("images/orbital.ico", &assets::bytes("crates/orbital-game/assets/orbital.ico", 2));
    p.write("images/fuel.svg", &svg::from_canvas(&art::icon("fuel", 2), 8));
    p.write_bytes("audio/laser.wav", &assets::bytes("assets/audio/sfx/laser.wav", 2));
    p.write_bytes("media/trailer.webm", encoded::TRAILER_V2);
    p.write_bytes("fonts/OrbitalHud.ttf", &glyphs::hud_font(2));
    p.write_bytes("docs/design.pdf", &design_doc::pdf(2));
    p.write("site/index.html", PRESS_HTML_V2);
    p.write("site/style.css", PRESS_CSS_V2);
    p.write("data/commodities.csv", COMMODITIES_V2);
    p.write("data/stations.tsv", STATIONS_V2);
    p.write("notes/devlog.md", DEVLOG_V2);
    p.write_bytes("saves/slot1.orbsave", &data::orbsave(2));
    p.commit("noor", "Refresh the press kit for 1.1");
}

/// git refuses a local submodule URL unless `protocol.file.allow=always`.
const FILE_OK: [&str; 2] = ["-c", "protocol.file.allow=always"];

pub fn submodules(r: &TestRepo) {
    let mut p = Play::new(r, 2026, 6, 1, 9);
    let root = r.root().to_path_buf();
    let source = |p: &mut Play, name: &str| {
        p.git_in(&root, "ilse", &["init", "-q", "-b", "main", name]);
        root.join(name)
    };
    let add = |p: &mut Play, dir: &Path, who: &str, file: &str, text: &str, subject: &str| {
        let path = dir.join(file);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("create dirs");
        std::fs::write(&path, text).expect("write source file");
        p.git_in(dir, who, &["add", "-A"]);
        p.git_in(dir, who, &["commit", "-q", "-m", subject]);
    };
    let netcode = source(&mut p, "netcode-src");
    add(&mut p, &netcode, "kasimir", "Cargo.toml", "[package]\nname = \"netcode\"\nversion = \"0.1.0\"\nedition = \"2021\"\n", "Start the netcode crate");
    std::fs::create_dir_all(netcode.join("src")).expect("src dir");
    std::fs::write(netcode.join("src/snapshot.rs"), "/// The world at one tick.\npub struct Snapshot {\n    pub tick: u64,\n    pub ships: Vec<(u32, [f32; 2])>,\n}\n\nimpl Snapshot {\n    pub fn encode(&self) -> Vec<u8> {\n        let mut out = self.tick.to_le_bytes().to_vec();\n        for (id, pos) in &self.ships {\n            out.extend(id.to_le_bytes());\n            out.extend(pos[0].to_le_bytes());\n            out.extend(pos[1].to_le_bytes());\n        }\n        out\n    }\n}\n").expect("write snapshot.rs");
    add(&mut p, &netcode, "kasimir", "src/lib.rs", "//! Orbital's client/server protocol.\n\npub mod snapshot;\n\n/// How often the server sends the world.\npub const TICK_HZ: u32 = 10;\n", "Serialize snapshots");
    let shaders = source(&mut p, "shaders-src");
    add(&mut p, &shaders, "teodor", "starfield.wgsl", "// Parallax stars, three layers deep.\n@fragment\nfn fs_main(@location(0) uv: vec2<f32>) -> @location(0) vec4<f32> {\n    return vec4<f32>(uv, 0.2, 1.0);\n}\n", "Add the starfield shader");

    p.write("README.md", "# orbital-server\n\nThe authoritative server for Orbital's multiplayer: the netcode and the shaders its replays render with are submodules.\n");
    p.commit("ilse", "Start the server");
    // Relative to the repository (it has no remote), so `.gitmodules`, and the commit holding it,
    // don't name the folder the fixture was built in: the website demo's bundles stay byte-stable.
    for (url, path) in [("../netcode-src", "libs/netcode"), ("../shaders-src", "libs/shaders")] {
        p.git("ilse", &[FILE_OK[0], FILE_OK[1], "submodule", "add", "-q", url, path]);
    }
    p.git("ilse", &["commit", "-q", "-m", "Add the netcode and shaders submodules"]);

    // A commit that moves the netcode pointer: its diff names both commits.
    let sub = r.path().join("libs/netcode");
    p.at(2026, 6, 3, 11, 0);
    add(&mut p, &netcode, "kasimir", "src/lib.rs", "//! Orbital's client/server protocol.\n\npub mod snapshot;\n\n/// How often the server sends the world.\npub const TICK_HZ: u32 = 20;\n", "Send snapshots at 20 Hz");
    p.git_in(&sub, "teodor", &[FILE_OK[0], FILE_OK[1], "fetch", "-q", "origin"]);
    p.git_in(&sub, "teodor", &["checkout", "-q", "--detach", "origin/main"]);
    p.git("teodor", &["add", "libs/netcode"]);
    p.git("teodor", &["commit", "-q", "-m", "Update netcode to Send snapshots at 20 Hz"]);

    // The working copy: netcode checked out past the recorded commit, with an edited file.
    p.at(2026, 6, 5, 15, 0);
    add(&mut p, &netcode, "kasimir", "src/compress.rs", "/// Run-length encodes a snapshot's bytes.\npub fn compress(bytes: &[u8]) -> Vec<u8> {\n    let mut out = Vec::new();\n    let mut i = 0;\n    while i < bytes.len() {\n        let run = bytes[i..].iter().take(255).take_while(|b| **b == bytes[i]).count();\n        out.extend([run as u8, bytes[i]]);\n        i += run;\n    }\n    out\n}\n", "Compress snapshots");
    p.git_in(&sub, "teodor", &[FILE_OK[0], FILE_OK[1], "fetch", "-q", "origin"]);
    p.git_in(&sub, "teodor", &["checkout", "-q", "--detach", "origin/main"]);
    std::fs::write(sub.join("src/lib.rs"), "//! Orbital's client/server protocol.\n\npub mod compress;\npub mod snapshot;\n\n/// How often the server sends the world.\npub const TICK_HZ: u32 = 30;\n").expect("edit netcode");

    // The shaders: recorded, but never initialised here.
    p.git("ilse", &["submodule", "deinit", "-q", "-f", "libs/shaders"]);
    std::fs::remove_dir_all(r.path().join(".git/modules/libs/shaders")).expect("remove the shaders' clone");
}

pub fn lfs(r: &TestRepo) {
    let mut p = Play::new(r, 2026, 6, 8, 11);
    p.write(".gitattributes", "*.png filter=lfs diff=lfs merge=lfs -text\n*.psd filter=lfs diff=lfs merge=lfs -text\n");
    p.write("README.md", "# orbital-art\n\nSource art for Orbital, stored with Git LFS.\n");
    p.write("art/title.png", &lfs_store(r, &scenes::title(1).to_png()));
    // Never downloaded here: only its pointer exists.
    p.write("art/ships.psd", &lfs_pointer(&fake_psd(1)));
    p.commit("noor", "Track the art with Git LFS");

    p.at(2026, 6, 10, 16, 0);
    p.write("art/title.png", &lfs_store(r, &scenes::title(2).to_png()));
    p.write("art/ships.psd", &lfs_pointer(&fake_psd(2)));
    p.commit("noor", "Paint the dusk version of the title");

    // An uncommitted touch-up: a third render, in the store, its pointer in the working tree (what
    // the LFS clean filter leaves there), so `title.png` shows as modified with an LFS object on
    // the working side.
    p.write("art/title.png", &lfs_store(r, &scenes::title(3).to_png()));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn previews_changes_every_kind_of_file_and_stays_small() {
        let r = TestRepo::new();
        previews(&r);
        assert_eq!(r.git(&["log", "--format=%s"]), "Refresh the press kit for 1.1\nAdd the press kit");
        let changed = r.git(&["diff", "--name-only", "HEAD~1", "HEAD"]);
        for f in ["images/scout.png", "images/title.png", "images/thruster.gif", "images/orbital.ico", "images/fuel.svg", "audio/laser.wav", "media/trailer.webm", "fonts/OrbitalHud.ttf", "docs/design.pdf", "site/index.html", "site/style.css", "data/commodities.csv", "data/stations.tsv", "notes/devlog.md", "saves/slot1.orbsave"] {
            assert!(changed.lines().any(|l| l == f), "{f} changes in the second commit");
        }
        let all = r.git(&["ls-tree", "-r", "--name-only", "HEAD"]);
        for f in ["audio/menu-loop.ogg", "audio/docking-chime.opus", "site/hero.png", "site/leaderboard.html", "scripts/pack-assets.sh", "README.md"] {
            assert!(all.lines().any(|l| l == f), "{f} is at HEAD");
        }
        assert!(r.git(&["ls-files", "-s", "scripts/pack-assets.sh"]).starts_with("100755"));
        assert!(r.git(&["status", "--porcelain"]).is_empty());
        let size: u64 = r.git(&["count-objects", "-v"]).lines().find_map(|l| l.strip_prefix("size: ")).unwrap().parse().unwrap();
        assert!(size < 1_500, "the repository stays under 1.5 MB: {size} KiB");
        assert!(!r.git(&["log", "--format=%an %cn"]).contains("Ada"), "Orbital's people");
    }

    #[test]
    fn submodules_have_relative_urls_a_moved_pointer_a_dirty_checkout_and_an_uninitialised_one() {
        let r = TestRepo::new();
        submodules(&r);
        let status = r.git(&["submodule", "status"]);
        assert!(status.lines().any(|l| l.starts_with('+') && l.contains("libs/netcode")), "{status}");
        assert!(status.lines().any(|l| l.starts_with('-') && l.contains("libs/shaders")), "{status}");
        let sub = r.path().join("libs/netcode");
        assert_eq!(r.git_in(&sub, &["log", "-1", "--format=%s"]), "Compress snapshots");
        assert!(!r.git_in(&sub, &["status", "--porcelain"]).is_empty());
        assert!(r.git(&["show", "--format=%s", "--submodule=log", "HEAD"]).starts_with("Update netcode to Send snapshots at 20 Hz"));
        for name in ["libs/netcode", "libs/shaders"] {
            assert!(r.git(&["config", "-f", ".gitmodules", &format!("submodule.{name}.url")]).starts_with("../"), "{name}'s URL is relative");
        }
    }

    #[test]
    fn lfs_has_stored_and_missing_objects() {
        let r = TestRepo::new();
        lfs(&r);
        let pointer = |rev: &str, path: &str| gitbolt_core::lfs::parse_pointer(r.git(&["show", &format!("{rev}:{path}")]).as_bytes()).expect("a pointer");
        let store = r.path().join(".git/lfs");
        for rev in ["HEAD", "HEAD~1"] {
            let title = pointer(rev, "art/title.png");
            assert_eq!(std::fs::metadata(gitbolt_core::lfs::object_path(&store, &title.oid)).map(|m| m.len()).ok(), Some(title.size), "{rev}'s title is downloaded");
            assert!(!gitbolt_core::lfs::object_path(&store, &pointer(rev, "art/ships.psd").oid).exists());
        }
        assert_ne!(pointer("HEAD", "art/title.png"), pointer("HEAD~1", "art/title.png"));
        assert_eq!(r.git(&["status", "--porcelain"]), " M art/title.png");
        let wip = gitbolt_core::lfs::parse_pointer(std::fs::read(r.path().join("art/title.png")).unwrap().as_slice()).expect("a pointer");
        assert_ne!(wip, pointer("HEAD", "art/title.png"));
        assert!(gitbolt_core::lfs::object_path(&store, &wip.oid).exists(), "the working-tree version is downloaded");
    }
}
