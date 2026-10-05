#!/usr/bin/env bash
# Self-test for package-arch.sh: the pure parts of scripts/arch-pkg.py (version mapping, the
# dependency table and its unknown-name failure, mtree escaping), then a synthetic .deb through
# the whole script (archive order, .PKGINFO, .MTREE, chrome-sandbox root:root 4755).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
helper="$here/arch-pkg.py"
fail() { echo "test-package-arch: FAIL: $*" >&2; exit 1; }
eq() { [ "$2" = "$3" ] || fail "$1: expected '$3', got '$2'"; }

eq pkgver "$(python3 "$helper" pkgver '0.1.0+202610051325.ab4dbf9e')" '0.1.0.202610051325.ab4dbf9e'
eq pkgver-plain "$(python3 "$helper" pkgver '0.2.0')" '0.2.0'
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
info=$(tar -xOf "$work/p.tar" .PKGINFO)
for kv in 'pkgname = gitbolt' 'pkgver = 0.1.0.202610051325.ab4dbf9e-1' 'pkgdesc = A fast desktop Git client' \
          'arch = x86_64' 'license = custom' "builddate = $(date -u -d '2026-10-05 13:25' +%s)" \
          'depend = gcc-libs' 'depend = git' 'depend = glibc' 'depend = gtk4'; do
  grep -qxF "$kv" <<<"$info" || fail ".PKGINFO lacks '$kv': $info"
done
mtree=$(tar -xOf "$work/p.tar" .MTREE | gzip -dc)
eq mtree-head "$(head -2 <<<"$mtree" | tr '\n' '|')" '#mtree|/set type=file uid=0 gid=0 mode=644|'
grep -Eq '^\./\.PKGINFO time=[0-9]+\.0 size=[0-9]+ md5digest=[0-9a-f]{32} sha256digest=[0-9a-f]{64}$' <<<"$mtree" || fail ".MTREE lacks .PKGINFO: $mtree"
grep -Eq '^\./usr/share/GitBolt/chrome-sandbox time=[0-9]+\.0 mode=4755 size=10 ' <<<"$mtree" || fail ".MTREE chrome-sandbox line: $mtree"
grep -qxF "./usr/bin/gitbolt time=$(date -u -d '2026-10-05 13:25' +%s).0 mode=777 type=link link=../share/GitBolt/gitbolt" <<<"$mtree" || fail ".MTREE symlink line: $mtree"
grep -Eq '^\./usr/share/applications/Git\\040Bolt\.desktop ' <<<"$mtree" || fail ".MTREE escaping: $mtree"
grep -Eq '^\./usr time=[0-9]+\.0 mode=755 type=dir$' <<<"$mtree" || fail ".MTREE dir line: $mtree"
# An unknown dependency fails the whole build.
sed -i 's/^Depends: .*/Depends: libgtk-4-1, libfoo9/' "$pkg/DEBIAN/control"
dpkg-deb --root-owner-group -Zgzip -b "$pkg" "$work/u.deb" >/dev/null
"$here/package-arch.sh" "$work/u.deb" "$work/out2" 2>/dev/null && fail "package-arch accepted an unknown dependency"
echo "test-package-arch: OK"
