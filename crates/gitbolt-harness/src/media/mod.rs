//! Media for the showcase repositories, drawn, synthesized and typeset by our own code: images,
//! sound, fonts and PDFs. Deterministic: every random choice comes from a seeded `rng::Rng`.

pub mod audio;
pub mod canvas;
pub mod encoded;
pub mod font;
pub mod gif;
pub mod ico;
pub mod layout;
pub mod noise;
pub mod palette;
pub mod pdf;
pub mod png;
pub mod preview;
pub mod rng;
pub mod scene;
pub mod sprites;
pub mod svg;

#[cfg(test)]
pub(crate) mod check {
    /// What Pillow makes of `bytes` (format, width, height, frames), or `None` when this machine
    /// has no python3 with Pillow: the caller then skips that check. A file Pillow can't read
    /// fails the test.
    pub fn pillow(bytes: &[u8], suffix: &str) -> Option<(String, u32, u32, u32)> {
        let script = "import sys\ntry:\n    from PIL import Image\nexcept ImportError:\n    sys.exit(3)\nim = Image.open(sys.argv[1])\nim.load()\nprint(im.format, im.size[0], im.size[1], getattr(im, 'n_frames', 1))";
        let text = run(bytes, suffix, script)?;
        let f: Vec<&str> = text.split_whitespace().collect();
        Some((f[0].to_string(), f[1].parse().ok()?, f[2].parse().ok()?, f[3].parse().ok()?))
    }

    /// What Pillow's FreeType makes of a TrueType font: the size of the mask for "Ag0" at 16 px,
    /// then the bounding box of the same text, both as (width, height). Skips like `pillow`.
    pub fn pillow_font(bytes: &[u8]) -> Option<((i64, i64), (i64, i64))> {
        let script = "import sys\ntry:\n    from PIL import ImageFont\nexcept ImportError:\n    sys.exit(3)\nfont = ImageFont.truetype(sys.argv[1], 16)\nmask = font.getmask('Ag0')\nbox = font.getbbox('Ag0')\nprint(mask.size[0], mask.size[1], box[2] - box[0], box[3] - box[1])";
        let text = run(bytes, "ttf", script)?;
        let f: Vec<i64> = text.split_whitespace().map(|s| s.parse().unwrap_or(-1)).collect();
        Some(((f[0], f[1]), (f[2], f[3])))
    }

    /// Runs `script` under python3 with `bytes` written to a probe file named by `suffix`; the
    /// script gets that path as argv[1]. None when python3 or Pillow is missing (exit 3).
    fn run(bytes: &[u8], suffix: &str, script: &str) -> Option<String> {
        let dir = tempfile::tempdir().ok()?;
        let path = dir.path().join(format!("probe.{suffix}"));
        std::fs::write(&path, bytes).ok()?;
        let out = std::process::Command::new("python3").arg("-I").arg("-c").arg(script).arg(&path).output().ok()?;
        if out.status.code() == Some(3) {
            eprintln!("skipping the Pillow check: no Pillow here");
            return None;
        }
        assert!(out.status.success(), "Pillow can't read the {suffix}: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8(out.stdout).ok()
    }
}
