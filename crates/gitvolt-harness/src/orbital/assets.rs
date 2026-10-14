//! Every binary file in Orbital's history, by path and version, drawn, synthesized or typeset
//! by our own code (`media`, `orbital::art`, `scenes`, `glyphs`, `design_doc`).

use super::{art, data, design_doc, glyphs, scenes};
use crate::media::canvas::{Canvas, Dither, tone};
use crate::media::palette::{TEAL, VIOLET};
use crate::media::{audio, encoded, gif, ico, svg};

pub fn bytes(path: &str, version: u16) -> Vec<u8> {
    let named =
        |prefix: &str, ext: &str| path.strip_prefix(prefix).and_then(|p| p.strip_suffix(ext));
    if let Some(n) = named("assets/sprites/ships/", ".png") {
        return art::ship(
            match n {
                "prospector" => "miner",
                "tanker" => "freighter",
                n => n,
            },
            version,
        )
        .to_png();
    }
    if let Some(n) = named("assets/sprites/stations/", ".png") {
        return art::station(n, version).to_png();
    }
    if let Some(n) = named("assets/sprites/planets/", ".png") {
        return art::planet(n, version).to_png();
    }
    if let Some(n) = named("assets/ui/icons/", ".png") {
        return art::icon(n, version).to_png();
    }
    if let Some(n) = named("assets/ui/icons/", ".svg") {
        return svg::from_canvas(&art::icon(n, version), 2).into_bytes();
    }
    if let Some(kind) = named("press/img/screenshot-", ".png") {
        return scenes::screenshot(kind, version).scaled(2).to_png();
    }
    if let Some(n) = named("assets/audio/sfx/", ".wav") {
        let samples = match n {
            "engine_hum" => audio::engine_hum(version),
            "laser" => audio::laser(version),
            "docking_chime" => audio::docking_chime(version),
            "explosion" => audio::explosion(),
            "ui_click" => audio::ui_click(),
            "cargo_clank" => audio::cargo_clank(),
            other => panic!("no sound effect {other}"),
        };
        return audio::wav(&samples);
    }
    match path {
        "assets/sprites/asteroids.png" => art::asteroids(version).to_png(),
        "assets/sprites/fx/explosion.png" => art::explosion(version).to_png(),
        "assets/sprites/fx/thruster.png" => art::thruster(version).to_png(),
        "assets/title/title.png" => scenes::title(version).to_png(),
        "press/img/title.png" => scenes::title(version).scaled(2).to_png(),
        "assets/fonts/OrbitalHud.ttf" => glyphs::hud_font(version),
        "assets/audio/music/menu-loop.ogg" => encoded::MENU_LOOP.to_vec(),
        "docs/design/orbital-design.pdf" => design_doc::pdf(version),
        "press/trailer.webm" => if version >= 2 {
            encoded::TRAILER_V2
        } else {
            encoded::TRAILER_V1
        }
        .to_vec(),
        "docs/devlog/img/thruster.gif" => thruster_gif(version),
        "docs/devlog/img/orbit-map.png" => scenes::screenshot("orbit", 1).to_png(),
        "crates/orbital-game/assets/orbital.ico" => {
            ico::ico(&[16, 32, 48, 256].map(|s| app_icon(version, s)))
        }
        "saves/sample.orbsave" => data::orbsave(version),
        _ => panic!("no asset {path} v{version}"),
    }
}

/// The scout with its flame flickering, 4× (the devlog's animation).
fn thruster_gif(version: u16) -> Vec<u8> {
    let ship = art::ship("scout", 1);
    let frames: Vec<Canvas> = art::thruster_frames(version)
        .iter()
        .map(|flame| {
            let mut c = Canvas::new(ship.w.max(flame.w) + 2, ship.h + flame.h);
            c.blit(flame, (c.w as i32 - flame.w as i32) / 2, ship.h as i32 - 2);
            c.blit(&ship, (c.w as i32 - ship.w as i32) / 2, 0);
            c.scaled(4)
        })
        .collect();
    gif::animated(&frames, 8)
}

/// The game's icon: the scout on a disc (teal, then violet from v2).
pub fn app_icon(version: u16, size: u32) -> Canvas {
    let ramp = if version >= 2 { VIOLET } else { TEAL };
    let mut c = Canvas::new(size, size);
    let r = size as f32 / 2.0;
    for y in 0..size as i32 {
        for x in 0..size as i32 {
            let (dx, dy) = (x as f32 + 0.5 - r, y as f32 + 0.5 - r);
            if dx.hypot(dy) <= r - 0.5 {
                c.set(
                    x,
                    y,
                    tone(
                        ramp,
                        0.25 + 0.5 * (1.0 - y as f32 / size as f32),
                        x,
                        y,
                        Dither::Bayer,
                    ),
                );
            }
        }
    }
    let ship = art::ship("scout", version.min(2));
    let k = (size * 2 / 3 / ship.h).max(1);
    let s = ship.scaled(k);
    c.blit(
        &s,
        (size as i32 - s.w as i32) / 2,
        (size as i32 - s.h as i32) / 2,
    );
    c
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::orbital::corpus::FEATURES;
    use crate::orbital::story::parse_features;

    fn limit(path: &str) -> usize {
        match path.rsplit('.').next().unwrap_or("") {
            "png" if path.contains("title") => 260_000,
            "png" if path.contains("screenshot") || path.contains("orbit-map") => 90_000,
            "png" => 40_000,
            "pdf" | "webm" => 250_000,
            "wav" | "ogg" => 120_000,
            "ttf" | "gif" | "ico" => 40_000,
            "svg" => 20_000,
            "orbsave" => 1_000,
            other => panic!("no budget for .{other}"),
        }
    }

    #[test]
    fn every_asset_the_features_name_renders_within_its_budget() {
        let mut seen = 0;
        for f in parse_features(FEATURES).unwrap() {
            for a in &f.assets {
                let b = bytes(&a.path, a.version);
                assert!(
                    !b.is_empty() && b.len() < limit(&a.path),
                    "{} v{}: {} bytes",
                    a.path,
                    a.version,
                    b.len()
                );
                seen += 1;
            }
        }
        assert!(seen >= 60, "{seen} asset versions");
    }

    #[test]
    fn formats_are_what_their_extensions_say() {
        assert_eq!(&bytes("assets/sprites/ships/scout.png", 2)[1..4], b"PNG");
        assert_eq!(&bytes("docs/devlog/img/thruster.gif", 1)[..6], b"GIF89a");
        assert_eq!(
            &bytes("crates/orbital-game/assets/orbital.ico", 2)[..4],
            &[0, 0, 1, 0]
        );
        assert!(bytes("assets/ui/icons/fuel.svg", 1).starts_with(b"<svg "));
        assert_eq!(&bytes("assets/audio/sfx/laser.wav", 2)[..4], b"RIFF");
        assert_eq!(&bytes("assets/fonts/OrbitalHud.ttf", 3)[..4], &[0, 1, 0, 0]);
        assert!(bytes("docs/design/orbital-design.pdf", 2).starts_with(b"%PDF-"));
        assert_eq!(
            bytes("press/img/screenshot-trade.png", 1),
            bytes("press/img/screenshot-trade.png", 1),
            "deterministic"
        );
    }

    /// The real history with the real assets: every local file a page links or embeds exists in
    /// that commit's tree, from the first commit that mentions it.
    #[test]
    fn every_asset_a_page_links_exists_at_that_commit() {
        use crate::orbital::corpus::{Corpus, Messages};
        use crate::orbital::{
            content::Content,
            history::{History, fast_import},
            releases::RELEASES,
            schedule::{TARGET_COMMITS, run},
            story::plan,
        };
        use std::collections::{BTreeSet, HashMap};
        use std::{cell::RefCell, process::Command, rc::Rc};

        let corpus = Corpus::load();
        let messages = Messages::load();
        let mut rng = crate::orbital::history_rng();
        type Cache = HashMap<(String, u16), Rc<[u8]>>;
        let cache: RefCell<Cache> = RefCell::default();
        let real = |path: &str, v: u16| {
            cache
                .borrow_mut()
                .entry((path.to_string(), v))
                .or_insert_with(|| Rc::from(bytes(path, v)))
                .clone()
        };
        let plans = plan(
            &corpus,
            &parse_features(FEATURES).unwrap(),
            &messages,
            &real,
            &mut rng,
        )
        .unwrap();
        let mut hist = History::new();
        run(
            &plans,
            &Content {
                corpus: &corpus,
                sections: Default::default(),
            },
            &messages,
            &mut hist,
            &mut rng,
            &RELEASES,
            TARGET_COMMITS,
        );
        let dir = tempfile::tempdir().unwrap();
        let git = |args: &[&str]| {
            let out = Command::new("git")
                .current_dir(dir.path())
                .args(args)
                .envs(crate::orbital::people::git_env())
                .output()
                .unwrap();
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
            String::from_utf8_lossy(&out.stdout).trim_end().to_string()
        };
        git(&["init", "-q", "-b", "main"]);
        fast_import(&dir.path().join(".git"), &hist.finish(), None).unwrap();

        let mut checked = BTreeSet::new();
        let mut missing = BTreeSet::new();
        let mut at = String::new();
        let mut trees: HashMap<String, BTreeSet<String>> = HashMap::new();
        for l in git(&[
            "log",
            "--all",
            "--format=@%H",
            "--name-only",
            "--diff-filter=AM",
            "--",
            "*.md",
        ])
        .lines()
        .filter(|l| !l.is_empty())
        {
            if let Some(c) = l.strip_prefix('@') {
                at = c.to_string();
                continue;
            }
            let tree = trees.entry(at.clone()).or_insert_with(|| {
                git(&["ls-tree", "-r", "--name-only", &at])
                    .lines()
                    .map(str::to_string)
                    .collect()
            });
            let text = git(&["show", &format!("{at}:{l}")]);
            let base = l.rsplit_once('/').map_or("", |(d, _)| d);
            for target in text
                .split("](")
                .skip(1)
                .filter_map(|r| r.split(')').next())
                .chain(
                    text.split("src=\"")
                        .skip(1)
                        .filter_map(|r| r.split('"').next()),
                )
            {
                let target = target.split(['#', '?']).next().unwrap_or("");
                let ext = target.rsplit('.').next().unwrap_or("");
                if target.is_empty()
                    || target.contains("your-image")
                    || target.contains("://")
                    || ![
                        "png", "gif", "webm", "pdf", "svg", "ogg", "wav", "ttf", "ico", "orbsave",
                    ]
                    .contains(&ext)
                {
                    continue;
                }
                let mut parts: Vec<&str> = if target.starts_with('/') {
                    vec![]
                } else {
                    base.split('/').filter(|p| !p.is_empty()).collect()
                };
                for p in target.split('/') {
                    match p {
                        "" | "." => {}
                        ".." => {
                            parts.pop();
                        }
                        p => parts.push(p),
                    }
                }
                let path = parts.join("/");
                checked.insert(path.clone());
                if !tree.contains(&path) {
                    missing.insert(format!("{l} at {} links {path}", &at[..8]));
                }
            }
        }
        assert!(missing.is_empty(), "{missing:#?}");
        assert!(checked.len() >= 7, "{checked:?}");
        git(&["gc", "-q", "--aggressive", "--prune=now"]);
        eprintln!("packed: {}", git(&["count-objects", "-vH"]));
    }
}
