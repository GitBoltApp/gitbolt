#!/usr/bin/env bash
# Usage: scripts/check-deb.sh <package.deb> — the shippable-package checks of spec §18.
set -euo pipefail
deb=${1:?usage: check-deb.sh <package.deb>}
fail() { echo "check-deb: FAIL: $*" >&2; exit 1; }
deps=$(dpkg-deb -f "$deb" Depends)
echo "Depends: $deps"
grep -Eq '(^|, )libgtk-3-0' <<<"$deps" && fail "declares GTK 3 (run scripts/fix-deb.sh)"
grep -Eq '(^|, )libgtk-4-1' <<<"$deps" || fail "missing libgtk-4-1"
grep -Eq '(^|, )git \(>= 1:2\.40\)' <<<"$deps" || fail "missing git (>= 1:2.40)"
contents=$(dpkg-deb -c "$deb")
line=$(grep '/chrome-sandbox$' <<<"$contents") || fail "no chrome-sandbox in the payload"
[[ $line == -rwsr-xr-x\ root/root* || $line == -rwsr-xr-x\ 0/0* ]] || fail "chrome-sandbox is not root:root 4755: $line"
# The icon set (R3c): hicolor PNGs, the scalable SVG, and a desktop entry matching the window's
# WM_CLASS so the dock groups it and shows the icon (consistent with `just install-desktop`).
for s in 32x32 64x64 128x128 512x512; do
  grep -Eq " (\./)?usr/share/icons/hicolor/$s/apps/[^ ]+\.png\$" <<<"$contents" || fail "no hicolor $s PNG"
done
grep -Eq ' (\./)?usr/share/icons/hicolor/scalable/apps/[^ ]+\.svg$' <<<"$contents" || fail "no scalable SVG icon"
# The license notices (docs/licensing.md): GitBolt's license and the third-party notices.
# Plus the spell-check dictionary beside the binary, which the app copies into Chromium's profile
# (PRIVACY.md: spell check works offline).
for f in doc/gitbolt/{LICENSE,THIRD-PARTY-NOTICES-rust.txt,THIRD-PARTY-NOTICES-ui.txt,CEF-LICENSE.txt,CHROMIUM-CREDITS.html.gz,DICTIONARY-en-US-LICENSE.txt} \
  GitBolt/dictionaries/en-US-10-1.bdic; do
  size=$(awk -v p="usr/share/$f" '$1 ~ /^-/ && ($NF == p || $NF == "./" p) { print $3 }' <<<"$contents")
  [ -n "$size" ] || fail "no /usr/share/$f"
  [ "$size" -gt 0 ] || fail "/usr/share/$f is empty"
done
desktop=$(dpkg-deb --fsys-tarfile "$deb" | tar -xO --wildcards '*usr/share/applications/*.desktop' 2>/dev/null) || true
[ -n "$desktop" ] || fail "no .desktop entry"
grep -E '^(Name|Categories|Icon|StartupWMClass)=' <<<"$desktop"
grep -Eq '^Categories=.*Development;' <<<"$desktop" || fail "desktop entry lacks Categories=Development;"
grep -qx 'StartupWMClass=gitbolt' <<<"$desktop" || fail "desktop entry lacks StartupWMClass=gitbolt"
echo "check-deb: OK ($(du -h "$deb" | cut -f1))"
