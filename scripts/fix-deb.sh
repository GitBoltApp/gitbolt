#!/usr/bin/env bash
# Usage: scripts/fix-deb.sh <package.deb>
#
# The v3-alpha Tauri CLI always declares `Depends: libgtk-3-0` (tauri-cli 3.0.0-alpha.3,
# src/runtime/mod.rs:65-80), but the CEF runtime links GTK 4 (spec §18). This rewrites only the
# package's control member:
#   Depends = what dpkg-shlibdeps finds for every shipped ELF file
#           + tauri.conf.json's extra deps (libgtk-4-1, git), minus libgtk-3-0
# The data member is copied byte for byte, so chrome-sandbox keeps the root:root 4755 the bundler
# wrote. No re-extraction as a normal user can drop the setuid bit.
set -euo pipefail
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
awk -v d="Depends: $new" '/^Depends:/ { print d; done = 1; next } { print } END { if (!done) print d }' control/control > control/control.new
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
echo "fix-deb: Depends: $new"
