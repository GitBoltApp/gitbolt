#!/usr/bin/env bash
# Usage: scripts/check-rpm-pkg.sh <GitVolt-*.x86_64.rpm>
#
# Installs the RPM in a throwaway fedora:latest container (Docker and the network needed, so it's
# not part of `just package`) and checks that:
#   - rpm accepts its digests (rpm -K) and dnf installs it with every dependency resolved from
#     Fedora's repositories;
#   - `rpm -V gitvolt` finds no altered or missing file;
#   - chrome-sandbox is root:root 4755 after install;
#   - the license notices are installed although the image's dnf skips docs (tsflags=nodocs:
#     they're %license files), in /usr/share/doc/gitvolt and through /usr/share/licenses/gitvolt;
#   - the spell-check dictionary is in /usr/share/GitVolt/dictionaries/, and install-kind says rpm;
#   - the AppStream metainfo validates and names the gitvolt package, the desktop entry validates,
#     and the app-id icons are there;
#   - ldd finds every library of the binary and the bundled CEF .so files;
#   - the app starts headless (xvfb-run, as a normal user) without a missing library, as in
#     check-arch-pkg.sh: under Docker's default seccomp profile the setuid sandbox can't make its
#     namespaces, so the launch passes when it gets as far as CEF's zygote;
#   - dnf removes it cleanly, leaving none of its files.
# The container is removed afterwards (--rm, and on interrupt); no other image or container is touched.
set -euo pipefail
pkg=$(realpath "${1:?usage: check-rpm-pkg.sh <GitVolt-*.x86_64.rpm>}")
[ -f "$pkg" ] || { echo "check-rpm-pkg: no such file: $pkg" >&2; exit 1; }
name="gitvolt-rpm-check-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT INT TERM
docker run --rm --name "$name" -v "$pkg:/pkg/$(basename "$pkg"):ro" -e PKG="/pkg/$(basename "$pkg")" \
  fedora:latest bash -c '
set -euo pipefail
fail() { echo "check-rpm-pkg: FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
step "rpm -K"
rpm -Kv "$PKG" | tee /tmp/k.log
grep -q "Header SHA256 digest: OK" /tmp/k.log && grep -q "Payload SHA256 digest: OK" /tmp/k.log || fail "rpm -K"
grep -Eqi "BAD|NOT OK" /tmp/k.log && fail "rpm -K found a bad digest"
step "rpm -qpR (Requires)"
rpm -qpR "$PKG"
step "dnf install $PKG"
# Without weak dependencies: only what the Requires pull in (and quicker).
dnf install -y -q --setopt=install_weak_deps=False "$PKG" 2>&1 | tee /tmp/install.log
# The package is not signed (no release package is), so dnf says it skipped the OpenPGP check of
# the local file; any other warning fails.
grep -Ei "^(warning|error)|scriptlet failed|conflict" /tmp/install.log |
  grep -vxF "Warning: skipped OpenPGP checks for 1 package from repository: @commandline" && fail "dnf install warned"
rpm -q gitvolt >/dev/null || fail "dnf did not install gitvolt"
step "rpm -qi gitvolt"
rpm -qi gitvolt
step "rpm -V gitvolt"
rpm -V gitvolt || fail "rpm -V reported problems"
step "chrome-sandbox ownership and mode"
s=$(stat -c "%U:%G %a %A" /usr/share/GitVolt/chrome-sandbox); echo "$s"
[ "$s" = "root:root 4755 -rwsr-xr-x" ] || fail "chrome-sandbox is $s"
step "license notices (installed despite tsflags=nodocs)"
grep -q "^tsflags=nodocs" /etc/dnf/dnf.conf || echo "(this image no longer sets tsflags=nodocs)"
for f in LICENSE copyright THIRD-PARTY-NOTICES-rust.txt THIRD-PARTY-NOTICES-ui.txt CEF-LICENSE.txt CHROMIUM-CREDITS.html.gz DICTIONARY-en-US-LICENSE.txt; do
  [ -s "/usr/share/licenses/gitvolt/$f" ] || fail "no /usr/share/licenses/gitvolt/$f (or it is empty)"
done
rpm -qL gitvolt
ls -lL /usr/share/licenses/gitvolt/
step "spell-check dictionary and install kind"
[ -s /usr/share/GitVolt/dictionaries/en-US-10-1.bdic ] || fail "no /usr/share/GitVolt/dictionaries/en-US-10-1.bdic (or it is empty)"
[ "$(head -c 4 /usr/share/GitVolt/dictionaries/en-US-10-1.bdic)" = BDic ] || fail "en-US-10-1.bdic is not a .bdic"
[ "$(cat /usr/share/GitVolt/install-kind)" = rpm ] || fail "install-kind is not rpm"
step "AppStream metainfo, desktop entry and icons"
dnf install -y -q appstream desktop-file-utils >/dev/null 2>&1 || fail "installing appstream"
m=/usr/share/metainfo/com.gitvolt.desktop.metainfo.xml
appstreamcli validate --pedantic --no-net "$m" || fail "appstreamcli rejects $m"
grep -qx "  <pkgname>gitvolt</pkgname>" "$m" || fail "$m does not name the gitvolt package"
desktop-file-validate /usr/share/applications/GitVolt.desktop || fail "desktop-file-validate rejects GitVolt.desktop"
for s in 32x32 64x64 128x128 256x256 512x512; do
  [ -s "/usr/share/icons/hicolor/$s/apps/com.gitvolt.desktop.png" ] || fail "no $s icon"
done
[ -s /usr/share/icons/hicolor/scalable/apps/com.gitvolt.desktop.svg ] || fail "no scalable icon"
step "ldd"
missing=0
for f in /usr/share/GitVolt/gitvolt /usr/share/GitVolt/*.so*; do
  out=$(ldd "$f"); n=$(grep -c "not found" <<<"$out" || true)
  echo "$f: $(grep -c "=>" <<<"$out") libraries, $n not found"
  [ "$n" = 0 ] || { grep "not found" <<<"$out"; missing=1; }
done
[ "$missing" = 0 ] || fail "ldd: missing libraries"
step "headless launch (xvfb-run, 20 s, as a normal user)"
dnf install -y -q /usr/bin/xvfb-run /usr/bin/xauth >/dev/null 2>&1 || fail "installing xvfb"
useradd -m tester
set +e
runuser -u tester -- env HOME=/home/tester timeout 20 xvfb-run -a gitvolt >/tmp/run.log 2>&1
rc=$?
set -e
tail -n 20 /tmp/run.log
echo "exit status: $rc (124 = still running when the 20 s timeout stopped it)"
grep -Ei "error while loading shared libraries|cannot open shared object" /tmp/run.log && fail "launch: missing library"
if [ "$rc" = 124 ]; then
  echo "launch: still running after 20 s"
elif grep -q "Failed to move to new namespace" /tmp/run.log; then
  # As in check-arch-pkg.sh: Docker forbids the namespaces the setuid sandbox creates.
  echo "launch: reached CEF'"'"'s sandboxed zygote, which Docker'"'"'s seccomp/capabilities block (expected here); every library loaded"
else
  fail "the app exited on its own (status $rc) within 20 s"
fi
step "dnf remove gitvolt"
dnf remove -y -q gitvolt 2>&1 | tee /tmp/remove.log
grep -Ei "^(warning|error)" /tmp/remove.log && fail "dnf remove warned"
for p in /usr/share/GitVolt /usr/share/doc/gitvolt /usr/share/licenses/gitvolt /usr/bin/gitvolt /usr/share/applications/GitVolt.desktop; do
  [ -e "$p" ] || [ -L "$p" ] && fail "$p is left after dnf remove"
done
echo; echo "check-rpm-pkg: OK"
'
