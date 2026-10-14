#!/usr/bin/env python3
"""Renders the app's icon set (crates/gitvolt-app/icons) from its three sources.

`source.svg` (thin lanes) makes every size through Tauri's own generator (`cargo tauri icon`).
Every output of 64 px or less is then replaced by a render of `source-mid.svg` (the same mark
with heavier lanes and rings): the 32/48/64 px ico layers, the 32/64 px icns entries and the
small PNGs. The 16 and 24 px ico layers and the 16 px icns entry come from `source-small.svg`,
bolder still and without commit rings, which would turn to noise at that size.

    scripts/icons.py            (or `just icons`)
"""
import io
import shutil
import struct
import subprocess
import tempfile
from pathlib import Path

from PIL import Image

ICONS = Path(__file__).resolve().parent.parent / "crates" / "gitvolt-app" / "icons"
SMALL = (16, 24)
MID_MAX = 64


def tauri_icon(source: Path, out: Path) -> None:
    subprocess.run(["cargo", "tauri", "icon", str(source), "-o", str(out)], cwd=ICONS.parent, check=True,
                   stdout=subprocess.DEVNULL)


def ico_layers(path: Path) -> dict[int, Image.Image]:
    ico = Image.open(path)
    layers = {}
    for w, h in ico.info["sizes"]:
        ico.size = (w, h)
        layers[w] = ico.convert("RGBA").copy()
    return layers


def set_icns(path: Path, entries: dict[bytes, bytes], drop: tuple[bytes, ...]) -> None:
    """Replaces the .icns file's PNG entries named in `entries` (type to PNG bytes, added if
    missing) and removes the `drop` types (legacy images and masks). An .icns is `icns` + total length, then entries of
    a 4-byte type and a 4-byte big-endian length (header included) before their data."""
    raw = path.read_bytes()
    assert raw[:4] == b"icns", f"{path} isn't an icns file"
    out, at = [], 8
    while at < len(raw):
        kind, n = raw[at:at + 4], struct.unpack(">I", raw[at + 4:at + 8])[0]
        if kind not in drop and kind not in entries:
            out.append(raw[at:at + n])
        at += n
    out += [k + struct.pack(">I", len(png) + 8) + png for k, png in entries.items()]
    entries = b"".join(out)
    path.write_bytes(b"icns" + struct.pack(">I", len(entries) + 8) + entries)


def png_bytes(img: Image.Image) -> bytes:
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def main() -> None:
    tauri_icon(ICONS / "source.svg", ICONS)
    with tempfile.TemporaryDirectory() as tmp:
        mid_out, small_out = Path(tmp) / "mid", Path(tmp) / "small"
        tauri_icon(ICONS / "source-mid.svg", mid_out)
        tauri_icon(ICONS / "source-small.svg", small_out)
        # PNGs of 64 px or less (32x32.png, Square30x30Logo.png, StoreLogo.png, ...).
        for png in sorted(ICONS.glob("*.png")):
            with Image.open(png) as im:
                size = im.width
            if size <= MID_MAX:
                shutil.copyfile(mid_out / png.name, png)
        big, mid, small = (ico_layers(d / "icon.ico") for d in (ICONS, mid_out, small_out))
        layers = {s: (small if s in SMALL else mid if s <= MID_MAX else big)[s] for s in big}
        sizes = sorted(layers)
        layers[sizes[-1]].save(ICONS / "icon.ico", sizes=[(s, s) for s in sizes],
                               append_images=[layers[s] for s in sizes[:-1]])
        # icon.icns: Tauri's, with the 16 px entry (`icp4`) from the small mark and the 32/64 px
        # ones (`ic11`, `ic12`) from the mid one; the legacy 16/32 px images and masks go.
        mid_png = lambda n: png_bytes(Image.open(mid_out / n).convert("RGBA"))
        set_icns(ICONS / "icon.icns", {b"icp4": png_bytes(small[16]), b"ic11": mid_png("32x32.png"),
                                       b"ic12": mid_png("64x64.png")},
                 drop=(b"is32", b"s8mk", b"il32", b"l8mk"))


if __name__ == "__main__":
    main()
