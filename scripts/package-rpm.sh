#!/usr/bin/env bash
# Usage: scripts/package-rpm.sh <package.deb> [out-dir]
#
# Turns the built (and fix-deb'ed) .deb into an RPM for Fedora, RHEL and openSUSE,
# GitVolt-<version>-1.x86_64.rpm, without rpmbuild (the build machine is Ubuntu). out-dir
# defaults to target/release/bundle/rpm. The writing is scripts/rpm-pkg.py's:
#   payload  = the .deb's data member: same paths and modes (chrome-sandbox stays root:root 4755),
#              less the system directories (/usr/bin is 555 on Fedora: a different mode would be
#              a file conflict), plus usr/share/licenses/gitvolt -> ../doc/gitvolt; the notices
#              are %license files, so dnf's nodocs keeps them; install-kind says rpm, and the
#              AppStream metainfo's <pkgname> becomes gitvolt
#   Version  = the .deb's (0.1.0~alpha.1 sorts before 0.1.0 in rpm too), Release 1
#   Requires = rpm's own form of what the ELF files need and the payload doesn't bring
#              (libgtk-4.so.1()(64bit), libc.so.6(GLIBC_2.34)(64bit): what rpmbuild would
#              generate, and the same on Fedora and openSUSE), plus git-core >= 2.40 from the
#              .deb's Depends (rpm-pkg.py depends: an unknown Debian name fails the build)
#   License  = MIT and the licenses of what the package bundles (arch-pkg.py licenses), as SPDX
# File times are the version's +YYYYMMDDHHMM build stamp, or $SOURCE_DATE_EPOCH; zstd -19.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
helper="$here/rpm-pkg.py"
deb=$(realpath "${1:?usage: package-rpm.sh <package.deb> [out-dir]}")
out=${2:-target/release/bundle/rpm}
fail() { echo "package-rpm: $*" >&2; exit 1; }
[ -f "$deb" ] || fail "no such file: $deb"
mkdir -p "$out"
out=$(realpath "$out")

debver=$(dpkg-deb -f "$deb" Version)
epoch=${SOURCE_DATE_EPOCH:-$(python3 "$here/arch-pkg.py" stamp "$debver" 2>/dev/null || stat -c %Y "$deb")}

# The work dir sits next to the output, not in /tmp (often tmpfs): the payload is ~350 MB.
work=$(mktemp -d "$out/.work.XXXXXX"); trap 'rm -rf "$work"' EXIT
(cd "$work" && ar x "$deb")
[ -f "$work/debian-binary" ] || fail "not a .deb: $deb"
data=$(cd "$work" && ls data.tar.*)
case "$data" in
  *.gz) unpack=(gzip -dc) ;;
  *.xz) unpack=(xz -dc) ;;
  *.zst) unpack=(zstd -dcq) ;;
  *.tar) unpack=(cat) ;;
  *) fail "unknown data member compression: $data" ;;
esac
"${unpack[@]}" "$work/$data" > "$work/data.tar"
rm "$work/$data"
mkdir "$work/control" "$work/pkg"
tar -xf "$work"/control.tar.* -C "$work/control"
# -p keeps the recorded modes (the owner may set setuid on its own file); a normal user can't
# chown, and the package records every file as root:root anyway.
tar -xpf "$work/data.tar" -C "$work/pkg" --no-same-owner
sandbox=$(find "$work/pkg" -name chrome-sandbox -type f)
[ -n "$sandbox" ] || fail "no chrome-sandbox in the payload"
chmod 4755 "$sandbox" # as the deb ships it; never drop the setuid bit

# The license notices (docs/licensing.md) are in the .deb's /usr/share/doc/gitvolt/; Fedora
# looks in /usr/share/licenses/<pkg>/, so that is a symlink to the same directory.
for f in LICENSE THIRD-PARTY-NOTICES-rust.txt THIRD-PARTY-NOTICES-ui.txt CEF-LICENSE.txt CHROMIUM-CREDITS.html.gz DICTIONARY-en-US-LICENSE.txt; do
  [ -s "$work/pkg/usr/share/doc/gitvolt/$f" ] || fail "the .deb has no usr/share/doc/gitvolt/$f (or it's empty)"
done
# The spell-check dictionary the app copies into Chromium's profile (PRIVACY.md).
[ -s "$work/pkg/usr/share/GitVolt/dictionaries/en-US-10-1.bdic" ] ||
  fail "the .deb has no usr/share/GitVolt/dictionaries/en-US-10-1.bdic (or it's empty)"
# How the package was installed (the update check picks the RPM by it): `rpm`, where the .deb
# says `deb` (an edited file for rpm-pkg.py verify, below).
[ "$(cat "$work/pkg/usr/share/GitVolt/install-kind" 2>/dev/null)" = deb ] || fail "the .deb has no usr/share/GitVolt/install-kind saying deb"
printf 'rpm\n' > "$work/pkg/usr/share/GitVolt/install-kind"
[ -e "$work/pkg/usr/share/licenses/gitvolt" ] && fail "the .deb's payload already has usr/share/licenses/gitvolt"
mkdir -p "$work/pkg/usr/share/licenses"
chmod 755 "$work/pkg/usr/share/licenses"
ln -s ../doc/gitvolt "$work/pkg/usr/share/licenses/gitvolt"
mapfile -t licenses < <(python3 "$here/arch-pkg.py" licenses "$work/pkg/usr/share/doc/gitvolt")
[ ${#licenses[@]} -gt 0 ] || fail "no licenses found"
license=${licenses[0]}
for l in "${licenses[@]:1}"; do license+=" AND $l"; done

# The AppStream metainfo's <pkgname> is the .deb's package name (gitvolt); a software centre
# matches the installed component to its package by it, so here it's this package's.
debpkg=$(dpkg-deb -f "$deb" Package)
edited=(usr/share/GitVolt/install-kind)
for m in "$work"/pkg/usr/share/metainfo/*.metainfo.xml; do
  [ -e "$m" ] || continue
  grep -qF "<pkgname>$debpkg</pkgname>" "$m" || fail "$(basename "$m") doesn't name the .deb's package, $debpkg"
  sed -i "s|<pkgname>$debpkg</pkgname>|<pkgname>gitvolt</pkgname>|" "$m"
  edited+=("${m#"$work/pkg/"}")
done

rm -f "$out"/GitVolt-*.x86_64.rpm
rpm=$(python3 "$helper" build "$work/control/control" "$work/pkg" "$out" "$epoch" "$license")
# Read back: digests, header against payload, and the payload against the .deb's.
python3 "$helper" verify "$work/data.tar" "$rpm" "${edited[@]}" >/dev/null || { rm -f "$rpm"; fail "the package doesn't match the .deb"; }
echo "package-rpm: $rpm ($(du -h "$rpm" | cut -f1)); version $(python3 "$helper" version "$debver")-1; license: $license"
