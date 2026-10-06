#!/usr/bin/env bash
# Self-test for check-deb.sh on a synthetic package (no Tauri build needed): a complete one
# passes, and one whose license notices are missing or empty fails.
set -euo pipefail
command -v dpkg-deb >/dev/null || { echo "test-check-deb: skipped (no dpkg-deb)"; exit 0; }
here=$(cd "$(dirname "$0")" && pwd)
fail() { echo "test-check-deb: FAIL: $*" >&2; exit 1; }
umask 022
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
pkg="$work/pkg"
mkdir -p "$pkg/DEBIAN" "$pkg/usr/share/GitBolt" "$pkg/usr/share/applications" "$pkg/usr/share/doc/gitbolt"
printf '#!/bin/sh\n' > "$pkg/usr/share/GitBolt/chrome-sandbox"
chmod 4755 "$pkg/usr/share/GitBolt/chrome-sandbox"
for s in 32x32 64x64 128x128 512x512; do
  mkdir -p "$pkg/usr/share/icons/hicolor/$s/apps"
  printf 'png' > "$pkg/usr/share/icons/hicolor/$s/apps/gitbolt.png"
done
mkdir -p "$pkg/usr/share/icons/hicolor/scalable/apps"
printf '<svg/>' > "$pkg/usr/share/icons/hicolor/scalable/apps/gitbolt.svg"
printf '[Desktop Entry]\nName=GitBolt\nIcon=gitbolt\nCategories=Development;\nStartupWMClass=gitbolt\n' > "$pkg/usr/share/applications/GitBolt.desktop"
notices="LICENSE THIRD-PARTY-NOTICES-rust.txt THIRD-PARTY-NOTICES-ui.txt CEF-LICENSE.txt CHROMIUM-CREDITS.html.gz DICTIONARY-en-US-LICENSE.txt"
for f in $notices; do printf 'notice %s\n' "$f" > "$pkg/usr/share/doc/gitbolt/$f"; done
mkdir -p "$pkg/usr/share/GitBolt/dictionaries"
printf 'BDic' > "$pkg/usr/share/GitBolt/dictionaries/en-US-10-1.bdic"
cat > "$pkg/DEBIAN/control" <<'EOT'
Package: gitbolt
Version: 0.1.0
Architecture: amd64
Maintainer: check-deb self-test <test@example.invalid>
Depends: libgtk-4-1, git (>= 1:2.40), libc6
Description: check-deb self-test
EOT
build() { dpkg-deb --root-owner-group -Zgzip -b "$pkg" "$work/t.deb" >/dev/null; }
build
"$here/check-deb.sh" "$work/t.deb" >/dev/null || fail "a complete package failed"
for f in $notices; do
  mv "$pkg/usr/share/doc/gitbolt/$f" "$work/saved"
  build
  err=$("$here/check-deb.sh" "$work/t.deb" 2>&1 >/dev/null) && fail "accepted a package without $f"
  grep -qF "$f" <<<"$err" || fail "unclear message without $f: $err"
  : > "$pkg/usr/share/doc/gitbolt/$f"
  build
  "$here/check-deb.sh" "$work/t.deb" >/dev/null 2>&1 && fail "accepted an empty $f"
  mv "$work/saved" "$pkg/usr/share/doc/gitbolt/$f"
done
# The spell-check dictionary, beside the binary.
dict="$pkg/usr/share/GitBolt/dictionaries/en-US-10-1.bdic"
mv "$dict" "$work/saved"
build
err=$("$here/check-deb.sh" "$work/t.deb" 2>&1 >/dev/null) && fail "accepted a package without the dictionary"
grep -qF "en-US-10-1.bdic" <<<"$err" || fail "unclear message without the dictionary: $err"
: > "$dict"
build
"$here/check-deb.sh" "$work/t.deb" >/dev/null 2>&1 && fail "accepted an empty dictionary"
mv "$work/saved" "$dict"
echo "test-check-deb: OK"
