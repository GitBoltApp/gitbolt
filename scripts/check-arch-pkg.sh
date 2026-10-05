#!/usr/bin/env bash
# Usage: scripts/check-arch-pkg.sh <GitBolt-*.pkg.tar.zst>
#
# Installs the Arch package in a throwaway archlinux:latest container (Docker and the network
# needed, so it's not part of `just package`) and checks that:
#   - pacman accepts it and every dependency resolves from Arch's repos;
#   - `pacman -Qkk gitbolt` finds the .MTREE and no altered files;
#   - chrome-sandbox is root:root 4755 after install;
#   - ldd finds every library of the binary and the bundled CEF .so files;
#   - the app starts headless (xvfb-run, as a normal user) without a missing library. Under
#     Docker's default seccomp profile and capabilities, the setuid sandbox can't make its
#     namespaces, so the launch passes when it gets as far as CEF's zygote (no extra privileges
#     are granted to the container).
# The container is removed afterwards (--rm, and on interrupt); no other image or container is touched.
set -euo pipefail
pkg=$(realpath "${1:?usage: check-arch-pkg.sh <GitBolt-*.pkg.tar.zst>}")
[ -f "$pkg" ] || { echo "check-arch-pkg: no such file: $pkg" >&2; exit 1; }
name="gitbolt-arch-check-$$"
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT INT TERM
docker run --rm --name "$name" -v "$pkg:/pkg/$(basename "$pkg"):ro" -e PKG="/pkg/$(basename "$pkg")" \
  archlinux:latest bash -c '
set -euo pipefail
fail() { echo "check-arch-pkg: FAIL: $*" >&2; exit 1; }
step() { echo; echo "== $*"; }
step "pacman -Syu (refresh, and no partial upgrade against the image)"
pacman -Syu --noconfirm --noprogressbar >/tmp/syu.log 2>&1 || { cat /tmp/syu.log; fail "pacman -Syu"; }
step "pacman -U $PKG"
pacman -U --noconfirm --noprogressbar "$PKG" 2>&1 | tee /tmp/u.log
grep -Ei "^(warning|error):|missing|corrupt|invalid" /tmp/u.log && fail "pacman -U warned"
step "pacman -Qi gitbolt"
pacman -Qi gitbolt | grep -E "^(Name|Version|Description|Architecture|URL|Licenses|Depends On|Installed Size|Packager|Build Date) "
step "pacman -Qkk gitbolt"
pacman -Qkk gitbolt 2>&1 | tee /tmp/qkk.log || fail "pacman -Qkk reported problems"
grep -qE "^gitbolt: [0-9]+ total files, 0 altered files$" /tmp/qkk.log || fail "pacman -Qkk found altered files"
grep -Ei "^(warning|error):|mtree" /tmp/qkk.log && fail "pacman -Qkk warned"
step "chrome-sandbox ownership and mode"
s=$(stat -c "%U:%G %a %A" /usr/share/GitBolt/chrome-sandbox); echo "$s"
[ "$s" = "root:root 4755 -rwsr-xr-x" ] || fail "chrome-sandbox is $s"
step "ldd"
missing=0
for f in /usr/share/GitBolt/gitbolt /usr/share/GitBolt/*.so*; do
  out=$(ldd "$f"); n=$(grep -c "not found" <<<"$out" || true)
  echo "$f: $(grep -c "=>" <<<"$out") libraries, $n not found"
  [ "$n" = 0 ] || { grep "not found" <<<"$out"; missing=1; }
done
[ "$missing" = 0 ] || fail "ldd: missing libraries"
step "headless launch (xvfb-run, 20 s, as a normal user)"
pacman -S --noconfirm --noprogressbar --needed xorg-server-xvfb xorg-xauth >/dev/null 2>&1 || fail "installing xvfb"
useradd -m tester
set +e
runuser -u tester -- env HOME=/home/tester timeout 20 xvfb-run -a gitbolt >/tmp/run.log 2>&1
rc=$?
set -e
tail -n 20 /tmp/run.log
echo "exit status: $rc (124 = still running when the 20 s timeout stopped it)"
grep -Ei "error while loading shared libraries|cannot open shared object" /tmp/run.log && fail "launch: missing library"
if [ "$rc" = 124 ]; then
  echo "launch: still running after 20 s"
elif grep -q "Failed to move to new namespace" /tmp/run.log; then
  # Docker'"'"'s default seccomp profile and capabilities forbid the PID/network namespaces the
  # setuid chrome-sandbox creates, so CEF'"'"'s zygote stops there. Getting that far means the
  # binary, GTK and CEF all loaded; the sandbox itself works on a real install.
  echo "launch: reached CEF'"'"'s sandboxed zygote, which Docker'"'"'s seccomp/capabilities block (expected here); every library loaded"
else
  fail "the app exited on its own (status $rc) within 20 s"
fi
echo; echo "check-arch-pkg: OK"
'
