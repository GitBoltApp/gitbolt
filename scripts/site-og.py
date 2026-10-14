#!/usr/bin/env python3
"""The site's social-sharing image (just site-og): the PNG site/scripts/og-image.ts rendered becomes
a JPEG, quality 90 without chroma subsampling (the gradient headline stays crisp), a fraction of the
PNG's size: link-preview scrapers don't all read WebP, and some refuse large files. Needs Pillow."""
import sys
from pathlib import Path

from PIL import Image

MAX_BYTES = 300_000

if __name__ == "__main__":
    src, out = Path(sys.argv[1]), Path(sys.argv[2])
    out.parent.mkdir(parents=True, exist_ok=True)
    Image.open(src).convert("RGB").save(out, quality=90, subsampling=0, optimize=True, progressive=True)
    size = out.stat().st_size
    print(f"{out}: {size // 1024} KB")
    if size > MAX_BYTES:
        sys.exit(f"{out}: {size} bytes, over {MAX_BYTES}")
