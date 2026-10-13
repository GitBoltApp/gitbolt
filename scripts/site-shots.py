#!/usr/bin/env python3
"""The site's screenshots (just site-shots): each raw PNG `<id>@<width>.png` that
site/e2e-shots/shots.spec.ts took at device scale 2 becomes `<id>.webp` at <width> px and
`<id>-1x.webp` at half that, WebP quality 90 (sharp at the size the page shows them, and a
fraction of a lossless file). Needs Pillow."""
import sys
from pathlib import Path

from PIL import Image


def convert(raw_dir: Path, out_dir: Path) -> list[Path]:
    written = []
    for raw in sorted(raw_dir.glob("*@*.png")):
        shot, width = raw.stem.rsplit("@", 1)
        img = Image.open(raw).convert("RGB")
        for name, w in ((f"{shot}.webp", int(width)), (f"{shot}-1x.webp", int(width) // 2)):
            h = round(img.height * w / img.width)
            out = out_dir / name
            img.resize((w, h), Image.LANCZOS).save(out, quality=90, method=6)
            written.append(out)
    return written


if __name__ == "__main__":
    out_dir = Path(sys.argv[2])
    out_dir.mkdir(parents=True, exist_ok=True)
    for path in convert(Path(sys.argv[1]), out_dir):
        print(f"{path}: {path.stat().st_size // 1024} KB")
