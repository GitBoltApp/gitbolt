#!/usr/bin/env bash
# Self-test for package-meta.py: the releases and tag it takes from a changelog, its refusals, and
# the real metainfo and copyright file, validated by appstreamcli (when installed) and
# python3-debian's DEP-5 parser (when installed).
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
meta() { python3 "$here/package-meta.py" "$@"; }
fail() { echo "test-package-meta: FAIL: $*" >&2; exit 1; }
eq() { [ "$2" = "$3" ] || fail "$1: expected '$3', got '$2'"; }
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

printf '<component>\n  <url>https://example.invalid/@TAG@/x</url>\n  <releases/>\n</component>\n' > "$work/t.xml.in"
cat > "$work/CHANGELOG.md" <<'EOT'
# Changelog

## [Unreleased]

- Something new.

## [0.3.0-rc.1] - 2026-11-02

## [0.2.0] - 2026-10-07

## [0.1.0] - 2026-10-06
EOT
meta metainfo "$work/t.xml.in" "$work/CHANGELOG.md" "$work/t.xml"
eq metainfo "$(cat "$work/t.xml")" '<component>
  <url>https://example.invalid/v0.3.0-rc.1/x</url>
  <releases>
    <release version="0.3.0-rc.1" date="2026-11-02"/>
    <release version="0.2.0" date="2026-10-07"/>
    <release version="0.1.0" date="2026-10-06"/>
  </releases>
</component>'
printf '# Changelog\n\n## [Unreleased]\n\n- Something.\n' > "$work/empty.md"
err=$(meta metainfo "$work/t.xml.in" "$work/empty.md" "$work/x.xml" 2>&1) && fail "accepted a changelog without releases"
grep -q 'no dated' <<<"$err" || fail "unclear message without releases: $err"
printf '<component/>\n' > "$work/bad.xml.in"
meta metainfo "$work/bad.xml.in" "$work/CHANGELOG.md" "$work/x.xml" 2>/dev/null && fail "accepted a template without <releases/>"
printf 'Apache License\n' > "$work/LICENSE"
meta copyright "$work/LICENSE" "$work/x" 2>/dev/null && fail "accepted a license that isn't MIT"

# The real files.
meta metainfo "$root/crates/gitbolt-app/linux/dev.gitbolt.desktop.metainfo.xml.in" "$root/CHANGELOG.md" "$work/m.xml"
meta copyright "$root/LICENSE" "$work/copyright"
if command -v appstreamcli >/dev/null; then
  appstreamcli validate --pedantic --no-net "$work/m.xml" >/dev/null || { appstreamcli validate --pedantic --no-net "$work/m.xml"; fail "appstreamcli rejects the metainfo"; }
else
  echo "test-package-meta: appstreamcli not installed; metainfo not validated"
fi
if python3 -c 'import debian.copyright' 2>/dev/null; then
  python3 - "$work/copyright" <<'EOF' || fail "the copyright file isn't valid DEP-5"
import sys, debian.copyright as c
cp = c.Copyright(open(sys.argv[1], encoding="utf-8"), strict=True)
assert cp.header.upstream_name == "GitBolt"
assert cp.find_files_paragraph("usr/share/GitBolt/gitbolt").license.synopsis == "MIT"
assert cp.find_files_paragraph("usr/share/GitBolt/libcef.so").license.synopsis == "BSD-3-Clause"
assert cp.find_files_paragraph("usr/share/GitBolt/dictionaries/en-US-10-1.bdic").license.synopsis == "SCOWL"
assert {p.license.synopsis for p in cp.all_license_paragraphs()} == {"MIT", "BSD-3-Clause", "SCOWL"}
EOF
else
  echo "test-package-meta: python3-debian not installed; copyright file not parsed"
fi
echo "test-package-meta: OK"
