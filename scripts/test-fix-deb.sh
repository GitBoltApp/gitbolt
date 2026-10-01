#!/usr/bin/env bash
# Self-test for fix-deb.sh on a synthetic package (no Tauri build needed). It checks that GTK 3
# goes, GTK 4 and git stay, dpkg-shlibdeps results arrive, the data member is byte-identical and
# chrome-sandbox keeps root:root 4755.
set -euo pipefail
command -v dpkg-shlibdeps >/dev/null || { echo "test-fix-deb: skipped (dpkg-dev not installed)"; exit 0; }
here=$(cd "$(dirname "$0")" && pwd)
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT
pkg="$work/pkg"
mkdir -p "$pkg/DEBIAN" "$pkg/usr/share/GitBolt"
cp /usr/bin/true "$pkg/usr/share/GitBolt/gitbolt"
printf '#!/bin/sh\n' > "$pkg/usr/share/GitBolt/chrome-sandbox"
chmod 4755 "$pkg/usr/share/GitBolt/chrome-sandbox"
cat > "$pkg/DEBIAN/control" <<'EOT'
Package: gitbolt
Version: 0.1.0
Architecture: amd64
Maintainer: fix-deb self-test <test@example.invalid>
Depends: libgtk-4-1, git (>= 1:2.30), libgtk-3-0
Description: fix-deb self-test
EOT
dpkg-deb --root-owner-group -Zgzip -b "$pkg" "$work/t.deb" >/dev/null
data_sum() { (cd "$work" && ar p t.deb "$(ar t t.deb | grep '^data\.tar')" | sha256sum); }
before=$(data_sum)
"$here/fix-deb.sh" "$work/t.deb"
deps=$(dpkg-deb -f "$work/t.deb" Depends)
fail() { echo "test-fix-deb: FAIL: $*" >&2; exit 1; }
grep -Eq '(^|, )libgtk-3-0' <<<"$deps" && fail "GTK 3 still declared: $deps"
grep -Eq '(^|, )libgtk-4-1' <<<"$deps" || fail "lost libgtk-4-1: $deps"
grep -Eq '(^|, )git \(>= 1:2\.30\)' <<<"$deps" || fail "lost the git requirement: $deps"
grep -Eq '(^|, )libc6 \(>= ' <<<"$deps" || fail "no dpkg-shlibdeps result: $deps"
[ "$(data_sum)" = "$before" ] || fail "the data member changed"
dpkg-deb -c "$work/t.deb" | grep -Eq '^-rwsr-xr-x (root/root|0/0) .*/chrome-sandbox$' || { dpkg-deb -c "$work/t.deb" >&2; fail "chrome-sandbox lost root:root 4755"; }
echo "test-fix-deb: OK ($deps)"
