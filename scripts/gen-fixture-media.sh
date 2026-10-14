#!/usr/bin/env bash
# Encodes the showcase's video and compressed audio, once, from frames and samples our own code
# makes (`gitvolt-harness media frames|wav`). The outputs are committed in
# crates/gitvolt-harness/src/fixture_data/, so building fixtures never needs ffmpeg; re-run this
# only to change them.
#
#   scripts/gen-fixture-media.sh HARNESS
set -euo pipefail
harness=${1:?usage: scripts/gen-fixture-media.sh HARNESS}
out=crates/gitvolt-harness/src/fixture_data
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
flags=(-loglevel error -y -fflags +bitexact)
out_flags=(-map_metadata -1 -fflags +bitexact -threads 1)
for v in 1 2; do
  "$harness" media frames "$tmp/v$v" "$v"
  ffmpeg "${flags[@]}" -framerate 12 -i "$tmp/v$v/frame-%03d.png" -c:v libvpx-vp9 -pix_fmt yuv420p -b:v 0 -crf 40 -row-mt 0 -threads 1 -flags:v +bitexact -an "${out_flags[@]}" "$out/trailer-v$v.webm"
done
"$harness" media wav "$tmp/wav"
ffmpeg "${flags[@]}" -i "$tmp/wav/menu-loop.wav" -c:a libvorbis -q:a 2 -flags:a +bitexact "${out_flags[@]}" "$out/menu-loop.ogg"
ffmpeg "${flags[@]}" -i "$tmp/wav/docking-chime.wav" -c:a libopus -b:a 32k -flags:a +bitexact "${out_flags[@]}" "$out/docking-chime.opus"
ls -l "$out"
