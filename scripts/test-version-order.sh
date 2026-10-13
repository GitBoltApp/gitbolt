#!/usr/bin/env bash
# Self-test: release versions keep their SemVer order once mapped for each package manager.
# The versions below are ascending; each is mapped to its .deb version (scripts/version.py deb,
# what fix-deb.sh writes), its Arch pkgver (scripts/arch-pkg.py pkgver of that) and its RPM
# Version (scripts/rpm-pkg.py version), and every neighbouring pair must compare "older" under
# `dpkg --compare-versions`, pacman's `vercmp` and rpm's `rpm.vercmp`.
# A `+<UTC time>.<commit>` stamp is a local build of the version before it.
# vercmp and rpm: the local ones when installed; else, with GITBOLT_TEST_DOCKER=1, in
# archlinux:latest and fedora:latest (Docker; not part of `just test-scripts`); else that part is
# skipped.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
fail() { echo "test-version-order: FAIL: $*" >&2; exit 1; }
order=(0.1.0-alpha 0.1.0-alpha.1 0.1.0-alpha.1+202610051325.ab4dbf9e 0.1.0-alpha.2 0.1.0-alpha.10
       0.1.0-beta 0.1.0-beta.1 0.1.0-rc.1 0.1.0-rc.1+202610061200.0123abc 0.1.0
       0.1.0+202610051325.ab4dbf9e 0.1.1-alpha.1 0.1.1 0.2.0 0.10.0-rc.1 0.10.0 1.0.0)
deb=() arch=() rpm=()
for v in "${order[@]}"; do
  d=$(python3 "$here/version.py" deb "$v")
  deb+=("$d")
  arch+=("$(python3 "$here/arch-pkg.py" pkgver "$d")")
  rpm+=("$(python3 "$here/rpm-pkg.py" version "$d")")
done
pairs() { local -n list=$1; for ((i = 0; i + 1 < ${#list[@]}; i++)); do echo "${list[i]} ${list[i + 1]}"; done; }

checked=()
if command -v dpkg >/dev/null; then
  while read -r a b; do
    dpkg --compare-versions "$a" lt "$b" || fail "dpkg: $a is not older than $b"
  done < <(pairs deb)
  checked+=(dpkg)
fi

# Prints the vercmp result of each "a b" line on stdin (expanded by the bash that runs it).
# shellcheck disable=SC2016
vercmp_lines='while read -r a b; do echo "$a $b $(vercmp "$a" "$b")"; done'
if command -v vercmp >/dev/null; then
  results=$(pairs arch | bash -c "$vercmp_lines")
elif [ "${GITBOLT_TEST_DOCKER:-}" = 1 ]; then
  results=$(pairs arch | docker run --rm -i archlinux:latest bash -c "$vercmp_lines")
fi
if [ -n "${results:-}" ]; then
  [ "$(wc -l <<<"$results")" = $((${#arch[@]} - 1)) ] || fail "vercmp gave $(wc -l <<<"$results") results: $results"
  while read -r a b r; do
    [ "$r" = -1 ] || fail "vercmp: $a is not older than $b ($r)"
  done <<<"$results"
  checked+=(vercmp)
fi
# rpm's comparison, through its Lua interpreter (rpmdev-vercmp needs rpmdevtools).
# shellcheck disable=SC2016
rpmcmp_lines='while read -r a b; do echo "$a $b $(rpm --eval "%{lua:print(rpm.vercmp(\"$a\", \"$b\"))}")"; done'
results=
if command -v rpm >/dev/null; then
  results=$(pairs rpm | bash -c "$rpmcmp_lines")
elif [ "${GITBOLT_TEST_DOCKER:-}" = 1 ]; then
  results=$(pairs rpm | docker run --rm -i fedora:latest bash -c "$rpmcmp_lines")
fi
if [ -n "$results" ]; then
  [ "$(wc -l <<<"$results")" = $((${#rpm[@]} - 1)) ] || fail "rpm gave $(wc -l <<<"$results") results: $results"
  while read -r a b r; do
    [ "$r" = -1 ] || fail "rpm: $a is not older than $b ($r)"
  done <<<"$results"
  checked+=(rpm)
fi
echo "test-version-order: OK (${checked[*]:-nothing: no dpkg, vercmp or rpm}; ${#order[@]} versions)"
