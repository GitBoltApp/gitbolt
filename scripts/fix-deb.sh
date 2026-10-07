#!/usr/bin/env bash
# Usage: scripts/fix-deb.sh <package.deb>
#
# The v3-alpha Tauri CLI always declares `Depends: libgtk-3-0` (tauri-cli 3.0.0-alpha.3 and alpha.4,
# src/runtime/mod.rs:65-80), but the CEF runtime links GTK 4 (spec §18). This rewrites only the
# package's control member:
#   Depends = what dpkg-shlibdeps finds for every shipped ELF file
#           + tauri.conf.json's extra deps (libgtk-4-1, git), minus libgtk-3-0
#   Version = the SemVer version as a Debian one (scripts/version.py deb): 0.1.0-alpha.1 becomes
#             0.1.0~alpha.1, which sorts before 0.1.0 (Tauri only takes SemVer)
#   License = MIT (LICENSE). Not a Debian field, but GNOME Software shows a local .deb's license
#             from it (its dpkg plugin, `dpkg-deb -W --showformat='${License}'`); Tauri can't
#             write it
# The data member is copied byte for byte, so chrome-sandbox keeps the root:root 4755 the bundler
# wrote. No re-extraction as a normal user can drop the setuid bit.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
license=MIT # the metainfo's project_license says the same (check-deb.sh compares them)
deb=$(realpath "${1:?usage: fix-deb.sh <package.deb>}")
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
cd "$work"
ar x "$deb"
[ -f debian-binary ] || { echo "fix-deb: not a .deb: $deb" >&2; exit 1; }
ctrl=$(ls control.tar.*)
data=$(ls data.tar.*)
mkdir control payload debian
tar -xf "$ctrl" -C control
# Unpacked only to be analysed; never repacked.
tar -xf "$data" -C payload --no-same-owner
mapfile -t elfs < <(find payload -type f -exec sh -c 'head -c 4 "$1" | grep -q ELF' _ {} \; -print | sort)
[ ${#elfs[@]} -gt 0 ] || { echo "fix-deb: no ELF files in $deb" >&2; exit 1; }
mapfile -t libdirs < <(printf '%s\n' "${elfs[@]}" | xargs -n1 dirname | sort -u)
printf 'Source: gitbolt\n\nPackage: gitbolt\nArchitecture: any\n' > debian/control
if ! shlib=$(dpkg-shlibdeps -O --ignore-missing-info "${libdirs[@]/#/-l}" "${elfs[@]/#/-e}" 2>shlibdeps.log | sed -n 's/^shlibs:Depends=//p'); then
  cat shlibdeps.log >&2
  exit 1
fi
orig=$(sed -n 's/^Depends: //p' control/control)
new=$(printf '%s\n%s\n' "$shlib" "$orig" | tr ',' '\n' | sed 's/^ *//; s/ *$//' | grep -v '^$' | grep -Ev '^libgtk-3-0([ (]|$)' | awk '
  { name = $1
    if (!(name in seen)) { seen[name] = $0; order[++n] = name }
    else if (index($0, "(") && !index(seen[name], "(")) seen[name] = $0 }
  END { for (i = 1; i <= n; i++) printf "%s%s", (i > 1 ? ", " : ""), seen[order[i]] }')
debver=$(python3 "$here/version.py" deb "$(sed -n 's/^Version: //p' control/control)")
awk -v d="Depends: $new" -v v="Version: $debver" -v l="License: $license" '
  /^License:/ { next }
  /^Depends:/ { print l; print d; done = 1; next }
  /^Version:/ { print v; next }
  { print }
  END { if (!done) { print l; print d } }' control/control > control/control.new
mv control/control.new control/control
case "$ctrl" in
  *.gz) comp=(-z) ;;
  *.xz) comp=(-J) ;;
  *.zst) comp=(--zstd) ;;
  *.tar) comp=() ;;
  *) echo "fix-deb: unknown control compression: $ctrl" >&2; exit 1 ;;
esac
(cd control && tar --owner=0 --group=0 --numeric-owner --sort=name "${comp[@]}" -cf "../$ctrl.new" .)
mv "$ctrl.new" "$ctrl"
rm -f "$deb.tmp"
ar rc "$deb.tmp" debian-binary "$ctrl" "$data" # member order matters to dpkg
mv "$deb.tmp" "$deb"
echo "fix-deb: Version: $debver; License: $license; Depends: $new"
