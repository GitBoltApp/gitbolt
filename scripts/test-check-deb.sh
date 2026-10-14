#!/usr/bin/env bash
# Self-test for check-deb.sh on a synthetic package (no Tauri build needed) that carries the real
# metainfo (scripts/package-meta.py), copyright file and desktop entry: a complete one passes, and
# one with a license notice, a control field or the metainfo missing, or the metainfo disagreeing
# with the package, fails.
set -euo pipefail
command -v dpkg-deb >/dev/null || { echo "test-check-deb: skipped (no dpkg-deb)"; exit 0; }
for tool in appstreamcli desktop-file-validate; do
  command -v "$tool" >/dev/null || { echo "test-check-deb: skipped (no $tool; apt install appstream desktop-file-utils)"; exit 0; }
done
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
app="$root/crates/gitvolt-app"
fail() { echo "test-check-deb: FAIL: $*" >&2; exit 1; }
umask 022
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
pkg="$work/pkg"
mkdir -p "$pkg/DEBIAN" "$pkg/usr/share/GitVolt" "$pkg/usr/share/applications" "$pkg/usr/share/doc/gitvolt" "$pkg/usr/share/metainfo"
printf '#!/bin/sh\n' > "$pkg/usr/share/GitVolt/chrome-sandbox"
chmod 4755 "$pkg/usr/share/GitVolt/chrome-sandbox"
for s in 32x32 64x64 128x128 256x256 512x512; do
  mkdir -p "$pkg/usr/share/icons/hicolor/$s/apps"
  printf 'png' > "$pkg/usr/share/icons/hicolor/$s/apps/com.gitvolt.desktop.png"
done
mkdir -p "$pkg/usr/share/icons/hicolor/scalable/apps"
printf '<svg/>' > "$pkg/usr/share/icons/hicolor/scalable/apps/com.gitvolt.desktop.svg"
sed -e 's/{{name}}/GitVolt/; s/{{comment}}/Fast, keyboard-friendly Git client/; s/{{exec}}/gitvolt/g' \
  "$app/linux/GitVolt.desktop.hbs" > "$pkg/usr/share/applications/GitVolt.desktop"
metainfo="$pkg/usr/share/metainfo/com.gitvolt.desktop.metainfo.xml"
python3 "$here/package-meta.py" metainfo "$app/linux/com.gitvolt.desktop.metainfo.xml.in" "$root/CHANGELOG.md" "$metainfo"
python3 "$here/package-meta.py" copyright "$root/LICENSE" "$pkg/usr/share/doc/gitvolt/copyright"
notices="LICENSE THIRD-PARTY-NOTICES-rust.txt THIRD-PARTY-NOTICES-ui.txt CEF-LICENSE.txt CHROMIUM-CREDITS.html.gz DICTIONARY-en-US-LICENSE.txt"
for f in $notices; do printf 'notice %s\n' "$f" > "$pkg/usr/share/doc/gitvolt/$f"; done
mkdir -p "$pkg/usr/share/GitVolt/dictionaries"
printf 'BDic' > "$pkg/usr/share/GitVolt/dictionaries/en-US-10-1.bdic"
printf 'deb\n' > "$pkg/usr/share/GitVolt/install-kind"
newest=$(sed -n 's/.*<release version="\([^"]*\)".*/\1/p' "$metainfo" | head -1)
cat > "$pkg/DEBIAN/control" <<EOT
Package: gitvolt
Conflicts: git-bolt (<< 0.7.0)
Replaces: git-bolt (<< 0.7.0)
Version: ${newest/-/\~}+202610051325.ab4dbf9e
Architecture: amd64
Maintainer: check-deb self-test <test@example.invalid>
Section: vcs
Homepage: https://example.invalid/gitvolt
License: MIT
Depends: libgtk-4-1, git (>= 1:2.40), libc6
Description: check-deb self-test
 The long description.
EOT
build() { dpkg-deb --root-owner-group -Zgzip -b "$pkg" "$work/t.deb" >/dev/null; }
build
"$here/check-deb.sh" "$work/t.deb" >/dev/null || fail "a complete package failed"
# rejects <message> <what>: check-deb fails on the current package with a message containing <message>.
rejects() {
  build
  local err
  err=$("$here/check-deb.sh" "$work/t.deb" 2>&1 >/dev/null) && fail "accepted a package with $2"
  grep -qF -- "$1" <<<"$err" || fail "unclear message for a package with $2: $err"
}
for f in $notices copyright; do
  mv "$pkg/usr/share/doc/gitvolt/$f" "$work/saved"
  rejects "$f" "no $f"
  : > "$pkg/usr/share/doc/gitvolt/$f"
  rejects "$f is empty" "an empty $f"
  mv "$work/saved" "$pkg/usr/share/doc/gitvolt/$f"
done
# The spell-check dictionary, beside the binary.
dict="$pkg/usr/share/GitVolt/dictionaries/en-US-10-1.bdic"
mv "$dict" "$work/saved"
rejects "en-US-10-1.bdic" "no dictionary"
: > "$dict"
rejects "en-US-10-1.bdic is empty" "an empty dictionary"
mv "$work/saved" "$dict"
# The control fields software centres show for a local .deb.
cp "$pkg/DEBIAN/control" "$work/control"
for f in Homepage Section License; do
  sed -i "/^$f:/d" "$pkg/DEBIAN/control"
  rejects "no $f field" "no $f field"
  cp "$work/control" "$pkg/DEBIAN/control"
done
# Replacing GitBolt's package (git-bolt, before 0.7.0), under GitVolt's own name.
for f in Conflicts Replaces; do
  sed -i "/^$f:/d" "$pkg/DEBIAN/control"
  rejects "$f doesn't name git-bolt (<< 0.7.0)" "no $f of git-bolt"
  cp "$work/control" "$pkg/DEBIAN/control"
done
sed -i 's/^Package: .*/Package: git-volt/' "$pkg/DEBIAN/control"
rejects "isn't named gitvolt" "Tauri's package name"
cp "$work/control" "$pkg/DEBIAN/control"
sed -i '/^ The long description\.$/d' "$pkg/DEBIAN/control"
rejects "long description" "no long description"
cp "$work/control" "$pkg/DEBIAN/control"
# The metainfo: present, valid, and agreeing with the package.
cp "$metainfo" "$work/metainfo"
rm "$metainfo"
rejects "expected one AppStream file" "no metainfo"
sed 's|<summary>.*</summary>||' "$work/metainfo" > "$metainfo"
rejects "appstreamcli rejects" "a metainfo without a summary"
sed 's|<pkgname>gitvolt</pkgname>|<pkgname>gitvolt-other</pkgname>|' "$work/metainfo" > "$metainfo"
rejects "metainfo pkgname" "another package's pkgname"
sed 's|<id>dev.gitbolt.desktop</id>|<id>dev.example.other</id>|' "$work/metainfo" > "$metainfo"
rejects "metainfo replaces" "a metainfo that doesn't replace GitBolt's"
sed 's|<project_license>MIT</project_license>|<project_license>Apache-2.0</project_license>|' "$work/metainfo" > "$metainfo"
rejects "metainfo project_license" "a license other than the control field's"
sed '/<release version=/{x;s/^/x/;/^x$/{x;d};x}' "$work/metainfo" > "$metainfo"
rejects "newest release" "a stale newest release"
cp "$work/metainfo" "$metainfo"
rm "$pkg/usr/share/icons/hicolor/256x256/apps/com.gitvolt.desktop.png"
rejects "no hicolor 256x256" "no 256x256 icon"
# The install kind the update check reads.
printf 'arch\n' > "$pkg/usr/share/GitVolt/install-kind"
rejects "install-kind" "an install-kind other than deb"
printf 'deb\n' > "$pkg/usr/share/GitVolt/install-kind"
echo "test-check-deb: OK"
