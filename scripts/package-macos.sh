#!/usr/bin/env bash
# Usage: scripts/package-macos.sh   (`just package-macos`, on a Mac)
#
# The macOS package: target/release/bundle/dmg/GitBolt_<version>_<arch>.dmg (arch: aarch64 on
# Apple Silicon, x64 on Intel), holding GitBolt.app and a link to /Applications.
#
# 1. The license notices (scripts/licenses.sh: the Rust crates of this Mac's target, CEF and
#    Chromium), failing on a license outside about.toml's allow-list.
# 2. `cargo tauri build --bundles app,dmg`, release: the UI build (with its own notices), the app,
#    then the bundle (tauri.macos.conf.json: the CEF framework, the helper apps, the folder
#    document type, an ad-hoc signature applied inside out) and the .dmg, from Tauri's own dmg
#    bundler. packaging/macos/dmg.conf.json adds the package's files to Contents/Resources: the
#    `install-kind` marker (`dmg`, for the updater) and the notices in `licenses/`.
# 3. Checks: the signature (`codesign --verify --deep --strict`), the marker, the notices and the
#    folder document type in the bundle, then the .dmg mounted read-only: GitBolt.app, signed,
#    and the Applications link.
#
# The version follows scripts/package-version.sh: a stamped one for local builds, the plain one
# with GITBOLT_RELEASE_VERSION (the release workflow). CARGO_BUILD_JOBS defaults to 4. Needs
# Xcode's command line tools, CMake, Ninja, Node, cargo-about and the pinned Tauri CLI
# (docs/dev-setup.md).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
fail() { echo "package-macos: $*" >&2; exit 1; }
[ "$(uname -s)" = Darwin ] || fail "builds on macOS only"
case "$(uname -m)" in
  arm64) arch=aarch64 ;;
  x86_64) arch=x64 ;;
  *) fail "unknown architecture $(uname -m)" ;;
esac

cd "$root"
scripts/licenses.sh
app_dir=crates/gitbolt-app
v=$(scripts/package-version.sh "$app_dir/tauri.conf.json")
bundle=target/release/bundle
app=$bundle/macos/GitBolt.app
dmg=$bundle/dmg/GitBolt_${v}_${arch}.dmg
tauri() {
  (cd "$app_dir" && env -u CARGO_INCREMENTAL CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" GITBOLT_BUILD_VERSION="$v" \
    cargo tauri "$@" --config packaging/macos/dmg.conf.json --config "{\"version\":\"$v\"}")
}
# Old bundles first: the checks below must see only what this build makes.
rm -rf "$bundle/macos" "$bundle/dmg"
# `hdiutil create` sometimes fails with "Resource busy" (a scan of the fresh image still holds
# it; common on CI runners): once the app is built, the .dmg alone is tried twice more.
if ! tauri build --bundles app,dmg; then
  [ -d "$app" ] || fail "the build failed"
  for try in 2 3; do
    echo "package-macos: the .dmg failed; trying again ($try of 3)" >&2
    sleep 15
    if tauri bundle --bundles dmg; then break; fi
    [ "$try" != 3 ] || fail "the .dmg failed three times"
  done
fi
[ -d "$app" ] || fail "no $app"
[ -f "$dmg" ] || fail "no $dmg: $(ls "$bundle/dmg" 2>/dev/null | tr '\n' ' ')"

check_app() {
  local app=$1 res=$1/Contents/Resources
  codesign --verify --deep --strict "$app" || fail "$app: the signature doesn't verify"
  [ "$(cat "$res/install-kind")" = dmg ] || fail "$app: no install-kind 'dmg' in Contents/Resources"
  for f in LICENSE THIRD-PARTY-NOTICES-rust.txt THIRD-PARTY-NOTICES-ui.txt CEF-LICENSE.txt CHROMIUM-CREDITS.html.gz DICTIONARY-en-US-LICENSE.txt; do
    [ -s "$res/licenses/$f" ] || fail "$app: licenses/$f is missing or empty"
  done
  [ -s "$res/dictionaries/en-US-10-1.bdic" ] || fail "$app: no spell-check dictionary"
  plutil -extract CFBundleDocumentTypes.0.LSItemContentTypes.0 raw "$app/Contents/Info.plist" | grep -qx public.folder ||
    fail "$app: Info.plist doesn't declare the folder document type"
  [ "$(plutil -extract CFBundleShortVersionString raw "$app/Contents/Info.plist")" = "$v" ] || fail "$app: not version $v"
}
check_app "$app"

mnt=$(mktemp -d "${TMPDIR:-/tmp}/gitbolt-dmg.XXXXXX")
trap 'hdiutil detach -quiet "$mnt" 2>/dev/null || hdiutil detach -quiet -force "$mnt" 2>/dev/null || true; rmdir "$mnt" 2>/dev/null || true' EXIT
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null
check_app "$mnt/GitBolt.app"
[ "$(readlink "$mnt/Applications")" = /Applications ] || fail "$dmg: no link to /Applications"
echo "package-macos: $dmg ($(du -h "$dmg" | cut -f1); GitBolt.app $(du -sh "$app" | cut -f1)), version $v"
