#!/usr/bin/env bash
# Usage: scripts/licenses.sh [out-dir]   (default: target/licenses)
#
# The license files the packages ship that don't come from the UI build (the UI build writes
# THIRD-PARTY-NOTICES-ui.txt itself, see ui/build/licenses.ts):
#   THIRD-PARTY-NOTICES-rust.txt  every crate gitbolt-app links, grouped by license (cargo-about,
#                                 then scripts/notices.py); fails on a license about.toml doesn't
#                                 accept, so a copyleft or unknown license stops the build
#   CEF-LICENSE.txt               CEF's own license, from the CEF distribution the build uses
#   CHROMIUM-CREDITS.html.gz         Chromium's credits for everything it bundles, from the same place
#   LICENSE                       GitBolt's license
#   DICTIONARY-en-US-LICENSE.txt  the spell-check dictionary's source and license (SCOWL), a copy
#                                 of crates/gitbolt-app/dictionaries/en-US-LICENSE.txt
# `just package` runs this before building, and scripts/package-windows.ps1 in Git for Windows'
# bash (the Windows graph and CEF build, with Python as $PYTHON); docs/licensing.md describes the
# whole flow.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
out=${1:-$root/target/licenses}
fail() { echo "licenses: $*" >&2; exit 1; }
command -v cargo-about >/dev/null ||
  fail "cargo-about isn't installed: cargo install cargo-about --version 0.9.2 --locked --features cli"
mkdir -p "$out"
python=${PYTHON:-python3}
# The graph and the CEF build of the platform the package is for: about.toml's targets (Linux),
# or Windows' in Git for Windows' bash.
case "$(uname -s)" in
  MINGW* | MSYS* | CYGWIN*) target=(--target x86_64-pc-windows-msvc) cef_platform=windows_x86_64 ;;
  *) target=() cef_platform=linux_x86_64 ;;
esac

# Rust. --locked: the notices describe exactly what Cargo.lock builds.
cargo about generate --format json --locked --fail -c "$root/about.toml" ${target[@]+"${target[@]}"} \
  -m "$root/crates/gitbolt-app/Cargo.toml" -o "$out/about.json"
"$python" "$here/notices.py" rust "$out/about.json" "$out/THIRD-PARTY-NOTICES-rust.txt"
rm "$out/about.json"

# CEF and Chromium: the distribution `cargo tauri` builds against. It sets CEF_PATH to
# $CEF_PATH or ~/.cache/tauri-cef, and cef-dll-sys unpacks CEF <version> into <that>/<version>/.
ver=$("$python" "$here/notices.py" cef-version "$root/Cargo.lock")
base=${CEF_PATH:-${XDG_CACHE_HOME:-$HOME/.cache}/tauri-cef}
cef_dir=$base/$ver/cef_$cef_platform
[ -f "$base/CREDITS.html" ] && [ ! -d "$base/$ver" ] && cef_dir=$base # CEF_PATH = an unpacked distribution
if [ ! -f "$cef_dir/CREDITS.html" ]; then
  # A first build on this machine: download CEF the way the app build does (cef-dll-sys's build
  # script), so the package build that follows finds it in place.
  echo "licenses: CEF $ver isn't in $base yet; downloading it through cef-dll-sys's build" >&2
  (cd "$root" && CEF_PATH=$base cargo build --release --locked -p cef-dll-sys)
fi
"$python" "$here/notices.py" cef "$cef_dir" "$out"

cp "$root/LICENSE" "$out/LICENSE"
cp "$root/crates/gitbolt-app/dictionaries/en-US-LICENSE.txt" "$out/DICTIONARY-en-US-LICENSE.txt"
for f in THIRD-PARTY-NOTICES-rust.txt CEF-LICENSE.txt CHROMIUM-CREDITS.html.gz LICENSE DICTIONARY-en-US-LICENSE.txt; do
  [ -s "$out/$f" ] || fail "$out/$f is missing or empty"
done
echo "licenses: wrote $(cd "$out" && ls | tr '\n' ' ')to $out"
echo "licenses: Rust crates by license:"
sed -n '/^Summary$/,/^$/p' "$out/THIRD-PARTY-NOTICES-rust.txt" | tail -n +3
