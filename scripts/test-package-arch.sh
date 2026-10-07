#!/usr/bin/env bash
# Self-test for package-arch.sh: the pure parts of scripts/arch-pkg.py (version mapping, the
# dependency table and its unknown-name failure, mtree escaping), then a synthetic .deb through
# the whole script (archive order, .PKGINFO and its licenses, .MTREE, the metainfo's pkgname,
# chrome-sandbox root:root 4755).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
helper="$here/arch-pkg.py"
fail() { echo "test-package-arch: FAIL: $*" >&2; exit 1; }
eq() { [ "$2" = "$3" ] || fail "$1: expected '$3', got '$2'"; }

eq pkgver "$(python3 "$helper" pkgver '0.1.0+202610051325.ab4dbf9e')" '0.1.0.202610051325.ab4dbf9e'
eq pkgver-plain "$(python3 "$helper" pkgver '0.2.0')" '0.2.0'
# A Debian pre-release ('~', from fix-deb.sh) sorts before the release under vercmp only when the
# word follows the number directly: 0.1.0.alpha.1 would be newer than 0.1.0 (test-version-order.sh).
eq pkgver-pre "$(python3 "$helper" pkgver '0.1.0~alpha.1')" '0.1.0alpha.1'
eq pkgver-pre-stamp "$(python3 "$helper" pkgver '0.1.0~rc.2+202610051325.ab4dbf9e')" '0.1.0rc.2.202610051325.ab4dbf9e'
python3 "$helper" pkgver '1:0.1.0' 2>/dev/null && fail "an epoch ':' was accepted"
python3 "$helper" pkgver '0.1.0-1' 2>/dev/null && fail "a '-' was accepted"
eq stamp "$(python3 "$helper" stamp '0.1.0+202610051325.ab4dbf9e')" "$(date -u -d '2026-10-05 13:25' +%s)"

deps=$(python3 "$helper" depends 'libasound2t64 (>= 1.0.17), libatk-bridge2.0-0t64 (>= 2.5.3), libatk1.0-0t64, libatspi2.0-0t64, libc6 (>= 2.39), libgcc-s1 (>= 12), libgtk-4-1 (>= 4.13.8), libnss3 (>= 2:3.30), libglib2.0-0t64 (>= 2.66.0), libxext6, git (>= 1:2.40)' | tr '\n' ' ')
eq depends "$deps" 'alsa-lib at-spi2-core gcc-libs git glib2 glibc gtk4 libxext nss '
err=$(python3 "$helper" depends 'libgtk-4-1, libfoo9 (>= 1), git' 2>&1 >/dev/null) && fail "an unknown dependency was accepted"
grep -q 'unknown Debian dependencies.*libfoo9' <<<"$err" || fail "unclear unknown-dependency message: $err"
python3 "$helper" depends 'libgtk-3-0' 2>/dev/null && fail "GTK 3 mapped (fix-deb.sh should have removed it)"

eq escape "$(python3 "$helper" escape 'usr/a b#c=d\e')" 'usr/a\040b\043c\075d\134e'
eq escape-utf8 "$(python3 "$helper" escape 'é')" '\303\251'
eq escape-plain "$(python3 "$helper" escape 'usr/share/GitBolt/libEGL.so')" 'usr/share/GitBolt/libEGL.so'

# The whole script on a synthetic .deb.
command -v dpkg-deb >/dev/null || { echo "test-package-arch: pure parts OK; package test skipped (no dpkg-deb)"; exit 0; }
umask 022
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
pkg="$work/pkg"
mkdir -p "$pkg/DEBIAN" "$pkg/usr/share/GitBolt" "$pkg/usr/bin" "$pkg/usr/share/applications"
cp /usr/bin/true "$pkg/usr/share/GitBolt/gitbolt"
printf '#!/bin/sh\n' > "$pkg/usr/share/GitBolt/chrome-sandbox"
chmod 4755 "$pkg/usr/share/GitBolt/chrome-sandbox"
printf '[Desktop Entry]\n' > "$pkg/usr/share/applications/Git Bolt.desktop"
ln -s ../share/GitBolt/gitbolt "$pkg/usr/bin/gitbolt"
notices="LICENSE THIRD-PARTY-NOTICES-rust.txt THIRD-PARTY-NOTICES-ui.txt CEF-LICENSE.txt CHROMIUM-CREDITS.html.gz DICTIONARY-en-US-LICENSE.txt"
mkdir -p "$pkg/usr/share/doc/gitbolt"
for f in $notices; do printf 'notice %s\n' "$f" > "$pkg/usr/share/doc/gitbolt/$f"; done
printf 'Rust notices\n\nSummary\n-------\n  MIT          40\n  Apache-2.0    2\n  Unicode-3.0   1\n\n\nMIT\n' \
  > "$pkg/usr/share/doc/gitbolt/THIRD-PARTY-NOTICES-rust.txt"
printf 'UI notices\n\nSummary\n-------\n  MIT     9\n  ISC     3\n  0BSD    1\n\n\nMIT\n' \
  > "$pkg/usr/share/doc/gitbolt/THIRD-PARTY-NOTICES-ui.txt"
mkdir -p "$pkg/usr/share/metainfo"
printf '<component>\n  <id>dev.gitbolt.desktop</id>\n  <pkgname>git-bolt</pkgname>\n</component>\n' \
  > "$pkg/usr/share/metainfo/dev.gitbolt.desktop.metainfo.xml"
mkdir -p "$pkg/usr/share/GitBolt/dictionaries"
printf 'BDic' > "$pkg/usr/share/GitBolt/dictionaries/en-US-10-1.bdic"
cat > "$pkg/DEBIAN/control" <<'EOT'
Package: git-bolt
Version: 0.1.0+202610051325.ab4dbf9e
Architecture: amd64
Maintainer: package-arch self-test <test@example.invalid>
Depends: libgtk-4-1 (>= 4.13.8), libc6 (>= 2.39), git (>= 1:2.40)
Description: A fast desktop Git client
 Long description.
EOT
dpkg-deb --root-owner-group -Zgzip -b "$pkg" "$work/t.deb" >/dev/null
SOURCE_DATE_EPOCH= "$here/package-arch.sh" "$work/t.deb" "$work/out" >/dev/null
out="$work/out/GitBolt-0.1.0.202610051325.ab4dbf9e-1-x86_64.pkg.tar.zst"
[ -f "$out" ] || fail "no package: $(ls "$work/out")"
zstd -dcq "$out" > "$work/p.tar"
eq order "$(tar -tf "$work/p.tar" | head -3 | tr '\n' ' ')" '.PKGINFO .MTREE usr/ '
tar -tvf "$work/p.tar" | grep -Eq '^-rwsr-xr-x root/root .* usr/share/GitBolt/chrome-sandbox$' || fail "chrome-sandbox lost root:root 4755"
tar -tvf "$work/p.tar" | grep -Eq '^lrwxrwxrwx root/root .* usr/bin/gitbolt -> \.\./share/GitBolt/gitbolt$' || fail "lost the /usr/bin/gitbolt symlink"
tar -tvf "$work/p.tar" | grep -Eq '^-rw-r--r-- root/root +4 .* usr/share/GitBolt/dictionaries/en-US-10-1\.bdic$' || fail "lost the dictionary"
info=$(tar -xOf "$work/p.tar" .PKGINFO)
for kv in 'pkgname = gitbolt' 'pkgver = 0.1.0.202610051325.ab4dbf9e-1' 'pkgdesc = A fast desktop Git client' \
          'arch = x86_64' "builddate = $(date -u -d '2026-10-05 13:25' +%s)" \
          'depend = gcc-libs' 'depend = git' 'depend = glibc' 'depend = gtk4'; do
  grep -qxF "$kv" <<<"$info" || fail ".PKGINFO lacks '$kv': $info"
done
eq licenses "$(sed -n 's/^license = //p' <<<"$info" | tr '\n' ' ')" \
  'MIT 0BSD Apache-2.0 BSD-3-Clause ISC LicenseRef-SCOWL Unicode-3.0 '
# The metainfo names this package, not the .deb's.
eq pkgname "$(tar -xOf "$work/p.tar" usr/share/metainfo/dev.gitbolt.desktop.metainfo.xml | sed -n 's|.*<pkgname>\(.*\)</pkgname>.*|\1|p')" gitbolt
mtree=$(tar -xOf "$work/p.tar" .MTREE | gzip -dc)
eq mtree-head "$(head -2 <<<"$mtree" | tr '\n' '|')" '#mtree|/set type=file uid=0 gid=0 mode=644|'
grep -Eq '^\./\.PKGINFO time=[0-9]+\.0 size=[0-9]+ md5digest=[0-9a-f]{32} sha256digest=[0-9a-f]{64}$' <<<"$mtree" || fail ".MTREE lacks .PKGINFO: $mtree"
grep -Eq '^\./usr/share/GitBolt/chrome-sandbox time=[0-9]+\.0 mode=4755 size=10 ' <<<"$mtree" || fail ".MTREE chrome-sandbox line: $mtree"
grep -qxF "./usr/bin/gitbolt time=$(date -u -d '2026-10-05 13:25' +%s).0 mode=777 type=link link=../share/GitBolt/gitbolt" <<<"$mtree" || fail ".MTREE symlink line: $mtree"
grep -Eq '^\./usr/share/applications/Git\\040Bolt\.desktop ' <<<"$mtree" || fail ".MTREE escaping: $mtree"
grep -Eq '^\./usr time=[0-9]+\.0 mode=755 type=dir$' <<<"$mtree" || fail ".MTREE dir line: $mtree"
# The license notices: the .deb's files, and Arch's /usr/share/licenses/gitbolt pointing at them.
# (The listing is read once: `tar | grep -q` under pipefail fails when grep stops reading early.)
listing=$(tar -tvf "$work/p.tar")
for f in $notices; do
  grep -Eq "^-rw-r--r-- root/root +[1-9][0-9]* .* usr/share/doc/gitbolt/$f\$" <<<"$listing" || fail "no usr/share/doc/gitbolt/$f"
done
grep -Eq '^lrwxrwxrwx root/root .* usr/share/licenses/gitbolt -> \.\./doc/gitbolt$' <<<"$listing" || fail "no usr/share/licenses/gitbolt symlink"
grep -Eq '^\./usr/share/licenses/gitbolt time=[0-9]+\.0 mode=777 type=link link=\.\./doc/gitbolt$' <<<"$mtree" || fail ".MTREE licenses symlink: $mtree"
# A .deb without them (or with an empty one) fails.
: > "$pkg/usr/share/doc/gitbolt/CEF-LICENSE.txt"
dpkg-deb --root-owner-group -Zgzip -b "$pkg" "$work/n.deb" >/dev/null
"$here/package-arch.sh" "$work/n.deb" "$work/out3" 2>/dev/null && fail "package-arch accepted an empty CEF-LICENSE.txt"
rm "$pkg/usr/share/doc/gitbolt/CEF-LICENSE.txt"
dpkg-deb --root-owner-group -Zgzip -b "$pkg" "$work/n.deb" >/dev/null
"$here/package-arch.sh" "$work/n.deb" "$work/out3" 2>/dev/null && fail "package-arch accepted a .deb without CEF-LICENSE.txt"
printf 'notice\n' > "$pkg/usr/share/doc/gitbolt/CEF-LICENSE.txt"
# Likewise without the spell-check dictionary.
mv "$pkg/usr/share/GitBolt/dictionaries/en-US-10-1.bdic" "$work/dict"
dpkg-deb --root-owner-group -Zgzip -b "$pkg" "$work/n.deb" >/dev/null
"$here/package-arch.sh" "$work/n.deb" "$work/out3" 2>/dev/null && fail "package-arch accepted a .deb without the dictionary"
mv "$work/dict" "$pkg/usr/share/GitBolt/dictionaries/en-US-10-1.bdic"
# An unknown dependency fails the whole build.
sed -i 's/^Depends: .*/Depends: libgtk-4-1, libfoo9/' "$pkg/DEBIAN/control"
dpkg-deb --root-owner-group -Zgzip -b "$pkg" "$work/u.deb" >/dev/null
"$here/package-arch.sh" "$work/u.deb" "$work/out2" 2>/dev/null && fail "package-arch accepted an unknown dependency"
echo "test-package-arch: OK"
