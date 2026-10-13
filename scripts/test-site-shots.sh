#!/usr/bin/env bash
# scripts/site-shots.py: a 2x PNG named <id>@<width>.png becomes <id>.webp at <width> and
# <id>-1x.webp at half, keeping the aspect ratio.
set -euo pipefail
python3 -c 'import PIL' 2>/dev/null || { echo "test-site-shots: skipped (no Pillow)"; exit 0; }
here="$(cd "$(dirname "$0")" && pwd)"
tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/raw" "$tmp/out"
python3 -c 'import sys; from PIL import Image; Image.new("RGB", (2400, 1500), (20, 30, 60)).save(sys.argv[1])' "$tmp/raw/sample@1440.png"
python3 "$here/site-shots.py" "$tmp/raw" "$tmp/out" >/dev/null
python3 - "$tmp/out" <<'PY'
import sys
from PIL import Image
d = sys.argv[1]
assert Image.open(f"{d}/sample.webp").size == (1440, 900), Image.open(f"{d}/sample.webp").size
assert Image.open(f"{d}/sample-1x.webp").size == (720, 450), Image.open(f"{d}/sample-1x.webp").size
assert Image.open(f"{d}/sample.webp").format == "WEBP"
PY
echo "test-site-shots: ok"
