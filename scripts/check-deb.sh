#!/usr/bin/env bash
# Usage: scripts/check-deb.sh <package.deb> — the shippable-package checks of spec §18.
# Needs dpkg-deb, python3, appstreamcli (appstream) and desktop-file-validate (desktop-file-utils).
set -euo pipefail
deb=${1:?usage: check-deb.sh <package.deb>}
fail() { echo "check-deb: FAIL: $*" >&2; exit 1; }
for tool in appstreamcli desktop-file-validate; do
  command -v "$tool" >/dev/null || fail "$tool isn't installed (sudo apt install appstream desktop-file-utils)"
done
deps=$(dpkg-deb -f "$deb" Depends)
echo "Depends: $deps"
grep -Eq '(^|, )libgtk-3-0' <<<"$deps" && fail "declares GTK 3 (run scripts/fix-deb.sh)"
grep -Eq '(^|, )libgtk-4-1' <<<"$deps" || fail "missing libgtk-4-1"
grep -Eq '(^|, )git \(>= 1:2\.40\)' <<<"$deps" || fail "missing git (>= 1:2.40)"
# What a software centre shows for a .deb that isn't installed: GNOME Software, Ubuntu's App
# Center and Discover read only the control fields then, never the package's AppStream file
# (docs/dev-setup.md). License is for GNOME Software (scripts/fix-deb.sh).
for f in Homepage Section License; do
  v=$(dpkg-deb -f "$deb" "$f")
  [ -n "$v" ] || fail "no $f field"
  echo "$f: $v"
done
[ "$(dpkg-deb -f "$deb" Description | wc -l)" -gt 1 ] || fail "the Description has no long description"
contents=$(dpkg-deb -c "$deb")
line=$(grep '/chrome-sandbox$' <<<"$contents") || fail "no chrome-sandbox in the payload"
[[ $line == -rwsr-xr-x\ root/root* || $line == -rwsr-xr-x\ 0/0* ]] || fail "chrome-sandbox is not root:root 4755: $line"
# The license notices (docs/licensing.md): GitBolt's license and the third-party notices, and the
# DEP-5 copyright file that points to them.
# Plus the spell-check dictionary beside the binary, which the app copies into Chromium's profile
# (PRIVACY.md: spell check works offline).
for f in doc/gitbolt/{copyright,LICENSE,THIRD-PARTY-NOTICES-rust.txt,THIRD-PARTY-NOTICES-ui.txt,CEF-LICENSE.txt,CHROMIUM-CREDITS.html.gz,DICTIONARY-en-US-LICENSE.txt} \
  GitBolt/dictionaries/en-US-10-1.bdic; do
  size=$(awk -v p="usr/share/$f" '$1 ~ /^-/ && ($NF == p || $NF == "./" p) { print $3 }' <<<"$contents")
  [ -n "$size" ] || fail "no /usr/share/$f"
  [ "$size" -gt 0 ] || fail "/usr/share/$f is empty"
done
# How the package was installed, beside the binary: the update check picks the .deb by it.
kind=$(dpkg-deb --fsys-tarfile "$deb" | tar -xO --wildcards '*usr/share/GitBolt/install-kind' 2>/dev/null) || true
[ "$kind" = deb ] || fail "/usr/share/GitBolt/install-kind isn't 'deb': '$kind'"

# The desktop entry, the AppStream metainfo and the copyright file, unpacked once.
meta=$(mktemp -d); trap 'rm -rf "$meta"' EXIT
dpkg-deb --fsys-tarfile "$deb" | tar -x -C "$meta" --wildcards \
  '*usr/share/applications/*' '*usr/share/metainfo/*' '*usr/share/doc/gitbolt/copyright' 2>/dev/null || true
head -1 "$meta/usr/share/doc/gitbolt/copyright" | grep -qx 'Format: https://www.debian.org/doc/packaging-manuals/copyright-format/1.0/' ||
  fail "/usr/share/doc/gitbolt/copyright isn't in the machine-readable (DEP-5) format"
shopt -s nullglob
desktops=("$meta"/usr/share/applications/*.desktop)
[ ${#desktops[@]} = 1 ] || fail "expected one .desktop entry, found ${#desktops[@]}"
desktop=$(<"${desktops[0]}")
grep -E '^(Name|Categories|Icon|StartupWMClass)=' <<<"$desktop"
# A desktop entry matching the window's WM_CLASS, so the dock groups it and shows the icon
# (consistent with `just install-desktop`).
grep -Eq '^Categories=.*Development;' <<<"$desktop" || fail "desktop entry lacks Categories=Development;"
grep -qx 'StartupWMClass=gitbolt' <<<"$desktop" || fail "desktop entry lacks StartupWMClass=gitbolt"
desktop-file-validate "${desktops[0]}" || fail "desktop-file-validate rejects ${desktops[0]##*/}"

# The AppStream metainfo (software centres, once installed): valid, and consistent with the
# desktop entry, the icons and the control fields.
metas=("$meta"/usr/share/metainfo/*.metainfo.xml)
[ ${#metas[@]} = 1 ] || fail "expected one AppStream file in /usr/share/metainfo, found ${#metas[@]}"
appstreamcli validate --pedantic --no-net "${metas[0]}" || fail "appstreamcli rejects ${metas[0]##*/}"
IFS=$'\t' read -r id launchable icon pkgname license release < <(python3 - "${metas[0]}" <<'EOF'
import sys, xml.etree.ElementTree as ET
c = ET.parse(sys.argv[1]).getroot()
t = lambda path: (c.findtext(path) or "").strip() or "-"
r = c.find("releases/release")
print("\t".join([t("id"), t("launchable[@type='desktop-id']"), t("icon[@type='stock']"), t("pkgname"),
                 t("project_license"), r.get("version") if r is not None else "-"]))
EOF
)
eq() { [ "$2" = "$3" ] || fail "$1: '$2', expected '$3'"; }
eq "metainfo file name" "${metas[0]##*/}" "$id.metainfo.xml"
eq "metainfo launchable" "$launchable" "${desktops[0]##*/}"
eq "metainfo icon" "$icon" "$(sed -n 's/^Icon=//p' <<<"$desktop")"
eq "metainfo pkgname" "$pkgname" "$(dpkg-deb -f "$deb" Package)"
eq "metainfo project_license" "$license" "$(dpkg-deb -f "$deb" License)"
# The newest release is this package's version (without the build stamp; '~' is SemVer's '-').
version=$(dpkg-deb -f "$deb" Version)
version=${version%%+*}
eq "metainfo's newest release" "$release" "${version/\~/-}"
# The icon set (R3c), named after the metainfo's icon: hicolor PNGs and the scalable SVG.
icon_re=${icon//./\\.}
for s in 32x32 64x64 128x128 256x256 512x512; do
  grep -Eq " (\./)?usr/share/icons/hicolor/$s/apps/$icon_re\.png\$" <<<"$contents" || fail "no hicolor $s $icon.png"
done
grep -Eq " (\./)?usr/share/icons/hicolor/scalable/apps/$icon_re\.svg\$" <<<"$contents" || fail "no scalable $icon.svg"
echo "AppStream: $id ($launchable, icon $icon, pkgname $pkgname, $license, release $release)"
echo "check-deb: OK ($(du -h "$deb" | cut -f1))"
