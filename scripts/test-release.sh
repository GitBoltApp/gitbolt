#!/usr/bin/env bash
# Self-test for the release tooling: scripts/version.py (SemVer checks and the Debian mapping),
# scripts/changelog.py (cutting a release section, extracting its notes), scripts/set-version.py,
# scripts/package-version.sh, and `just release` (scripts/release.sh) in a throwaway repository
# made from this checkout's real manifests. Nothing here touches this repository's refs.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/.." && pwd)
fail() { echo "test-release: FAIL: $*" >&2; exit 1; }
eq() { [ "$2" = "$3" ] || fail "$1: expected '$3', got '$2'"; }
ver() { python3 "$here/version.py" "$@"; }
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

# --- version.py ---------------------------------------------------------------------------------
for v in 0.1.0 1.2.3 10.20.30 0.1.0-alpha.1 0.1.0-alpha 0.1.0-beta.2 0.1.0-rc.10 1.0.0-alpha.beta.1; do
  ver check "$v" || fail "check rejected $v"
done
for v in '' 0.1 0.1.0.0 v0.1.0 01.2.3 0.01.0 0.1.0- 0.1.0-alpha..1 0.1.0+build.1 0.1.0-alpha+b \
         0.1.0-1 0.1.0-alpha-2 0.1.0-alpha.01 0.1.0-ALPHA.1 '0.1.0 ' 0.1.0-alpha_1; do
  ver check "$v" 2>/dev/null && fail "check accepted '$v'"
done
err=$(ver check 0.1.0-1 2>&1) && fail "check accepted 0.1.0-1"
grep -q 'pre-release must start with a lowercase word' <<<"$err" || fail "unclear message for 0.1.0-1: $err"

eq deb-plain "$(ver deb 0.1.0)" 0.1.0
eq deb-pre "$(ver deb 0.1.0-alpha.1)" '0.1.0~alpha.1'
eq deb-stamp "$(ver deb 0.1.0+202610051325.ab4dbf9e)" '0.1.0+202610051325.ab4dbf9e'
eq deb-pre-stamp "$(ver deb 0.1.0-rc.2+202610051325.ab4dbf9e)" '0.1.0~rc.2+202610051325.ab4dbf9e'
eq deb-idempotent "$(ver deb '0.1.0~alpha.1')" '0.1.0~alpha.1'
ver deb 0.1 2>/dev/null && fail "deb accepted 0.1"

eq prerelease-no "$(ver prerelease 0.1.0)" false
eq prerelease-yes "$(ver prerelease 0.1.0-rc.1)" true

# SemVer precedence, ascending.
order=(0.1.0-alpha 0.1.0-alpha.1 0.1.0-alpha.2 0.1.0-alpha.10 0.1.0-beta 0.1.0-beta.1 0.1.0-rc.1 0.1.0 0.1.1-alpha.1 0.1.1 0.2.0 0.10.0 1.0.0)
for ((i = 0; i + 1 < ${#order[@]}; i++)); do
  a=${order[i]} b=${order[i + 1]}
  eq "cmp $a $b" "$(ver cmp "$a" "$b")" -1
  eq "cmp $b $a" "$(ver cmp "$b" "$a")" 1
done
eq cmp-equal "$(ver cmp 0.1.0-rc.1 0.1.0-rc.1)" 0

# --- changelog.py -------------------------------------------------------------------------------
cat > "$work/CHANGELOG.md" <<'EOF'
# Changelog

Intro text.

## [Unreleased]

### Fixed

- A fix.

#### A sub-heading

- Another fix.

## [0.1.0-alpha.1] - 2026-10-01

### Added

- The first alpha.
EOF
cp "$work/CHANGELOG.md" "$work/CHANGELOG.orig"
python3 "$here/changelog.py" release 0.1.0-alpha.2 2026-10-06 "$work/CHANGELOG.md"
expected=$(sed 's/^## \[Unreleased\]$/## [Unreleased]\n\n## [0.1.0-alpha.2] - 2026-10-06/' "$work/CHANGELOG.orig")
eq release-cut "$(cat "$work/CHANGELOG.md")" "$expected"
eq notes "$(python3 "$here/changelog.py" notes 0.1.0-alpha.2 "$work/CHANGELOG.md")" "$(printf '### Fixed\n\n- A fix.\n\n#### A sub-heading\n\n- Another fix.')"
eq notes-last "$(python3 "$here/changelog.py" notes 0.1.0-alpha.1 "$work/CHANGELOG.md")" "$(printf '### Added\n\n- The first alpha.')"
err=$(python3 "$here/changelog.py" notes 0.1.0-alpha.3 "$work/CHANGELOG.md" 2>&1) && fail "notes for a missing version succeeded"
grep -q 'no "## \[0.1.0-alpha.3\]" section' <<<"$err" || fail "unclear missing-section message: $err"
# The fresh Unreleased section is empty, so it can't be released, and the file stays as it was.
cp "$work/CHANGELOG.md" "$work/before"
err=$(python3 "$here/changelog.py" release 0.1.0-alpha.3 2026-10-07 "$work/CHANGELOG.md" 2>&1) && fail "released an empty Unreleased section"
grep -q 'Unreleased section is empty' <<<"$err" || fail "unclear empty-section message: $err"
cmp -s "$work/before" "$work/CHANGELOG.md" || fail "a failed release changed CHANGELOG.md"
# An existing version is refused.
python3 "$here/changelog.py" release 0.1.0-alpha.1 2026-10-07 "$work/CHANGELOG.orig" 2>/dev/null && fail "released a version twice"
# Trailing link references don't leak into the last section's notes, and an empty section fails.
printf '# Changelog\n\n## [Unreleased]\n\n## [0.2.0] - 2026-10-06\n\n- One.\n\n## [0.1.0] - 2026-10-01\n\n- Two.\n\n[0.2.0]: https://example.com/a\n[0.1.0]: https://example.com/b\n' > "$work/links.md"
eq notes-links "$(python3 "$here/changelog.py" notes 0.1.0 "$work/links.md")" '- Two.'
python3 "$here/changelog.py" notes Unreleased "$work/links.md" 2>/dev/null && fail "empty notes accepted"
python3 "$here/changelog.py" release 0.3.0 2026-10-07 "$work/nonexistent.md" 2>/dev/null && fail "a missing file was accepted"
printf '# Changelog\n\n## [0.1.0] - 2026-10-01\n\n- One.\n' > "$work/nounrel.md"
err=$(python3 "$here/changelog.py" release 0.2.0 2026-10-07 "$work/nounrel.md" 2>&1) && fail "released without an Unreleased heading"
grep -q 'no "## \[Unreleased\]" heading' <<<"$err" || fail "unclear no-Unreleased message: $err"

# --- the throwaway repository -------------------------------------------------------------------
# Real copies of the files `just release` edits (as they are in this working tree), plus the
# scripts and the justfile, in a fresh repository with an isolated git config.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME='Release Test' GIT_AUTHOR_EMAIL=release-test@example.com
export GIT_COMMITTER_NAME='Release Test' GIT_COMMITTER_EMAIL=release-test@example.com
repo="$work/repo"
files=(CHANGELOG.md Cargo.toml Cargo.lock justfile crates/gitbolt-app/tauri.conf.json ui/package.json ui/package-lock.json
       scripts/version.py scripts/changelog.py scripts/set-version.py scripts/release.sh scripts/package-version.sh)
for f in "${files[@]}"; do mkdir -p "$repo/$(dirname "$f")"; cp "$root/$f" "$repo/$f"; done
for m in $(python3 -c 'import tomllib,sys; print(" ".join(tomllib.load(open(sys.argv[1],"rb"))["workspace"]["members"]))' "$root/Cargo.toml"); do
  mkdir -p "$repo/$m"; cp "$root/$m/Cargo.toml" "$repo/$m/Cargo.toml"
done
git -C "$repo" init -q -b main
git -C "$repo" config commit.gpgsign false
git -C "$repo" config tag.gpgsign false
# A non-empty Unreleased section to release.
python3 - "$repo/CHANGELOG.md" <<'EOF'
import re, sys
p = sys.argv[1]
s = open(p).read()
assert "## [Unreleased]\n" in s, "the real CHANGELOG.md has no [Unreleased] heading"
# Its body is replaced, not added to: the real section may already list changes.
s = re.sub(r"(## \[Unreleased\]\n).*?(?=\n## \[|\Z)", r"\1\n### Fixed\n\n- A release-test fix.\n", s, count=1, flags=re.S)
open(p, "w").write(s)
EOF
git -C "$repo" add -A
git -C "$repo" commit -q -m "Fixture"
git init -q --bare "$work/origin.git"
git -C "$repo" remote add origin "$work/origin.git"
git -C "$repo" push -q origin main
git -C "$repo" fetch -q origin
base=$(git -C "$repo" rev-parse HEAD)
old=$(jq -r .version "$repo/crates/gitbolt-app/tauri.conf.json")

release() { # runs `just release` when just is installed, else the script it calls
  if command -v just >/dev/null; then (cd "$repo" && just release "$@"); else (cd "$repo" && scripts/release.sh "$@"); fi
}
untouched() { # the failed release left no commit, no tag and no change behind
  eq "$1: HEAD" "$(git -C "$repo" rev-parse HEAD)" "$base"
  eq "$1: tags" "$(git -C "$repo" tag -l)" ""
  eq "$1: status" "$(git -C "$repo" status --porcelain --untracked-files=no)" ""
}

release 0.1 >/dev/null 2>&1 && fail "released an invalid version"; untouched invalid
release 0.1.0-1 >/dev/null 2>&1 && fail "released a numeric pre-release"; untouched numeric-pre

git -C "$repo" checkout -q -b topic
err=$(release 0.1.0-alpha.1 2>&1) && fail "released from a branch other than main"
grep -q 'not on main' <<<"$err" || fail "unclear branch message: $err"
git -C "$repo" checkout -q main; untouched branch

echo '// local edit' >> "$repo/Cargo.toml"
err=$(release 0.1.0-alpha.1 2>&1) && fail "released with uncommitted changes"
grep -q 'uncommitted changes' <<<"$err" || fail "unclear dirty-tree message: $err"
git -C "$repo" checkout -q -- Cargo.toml; untouched dirty

# main behind origin/main.
git -C "$repo" commit -q --allow-empty -m "Ahead"
git -C "$repo" push -q origin main
git -C "$repo" reset -q --hard "$base"
err=$(release 0.1.0-alpha.1 2>&1) && fail "released while main is behind origin/main"
grep -q 'behind origin/main' <<<"$err" || fail "unclear behind message: $err"
untouched behind
git -C "$repo" push -q -f origin main
git -C "$repo" fetch -q -p origin

# A late failure (here: the Unreleased section emptied) restores every file it touched.
cp "$repo/CHANGELOG.md" "$work/changelog.keep"
python3 - "$repo/CHANGELOG.md" <<'EOF'
import re, sys
p = sys.argv[1]
# The whole Unreleased body, not only the fix added above: the real one may list changes too.
s = re.sub(r"(## \[Unreleased\]\n).*?(?=\n## \[|\Z)", r"\1", open(p).read(), count=1, flags=re.S)
open(p, "w").write(s)
EOF
git -C "$repo" commit -q -am "Empty Unreleased"
base2=$(git -C "$repo" rev-parse HEAD)
git -C "$repo" push -q origin main
err=$(release 0.1.0-alpha.1 2>&1) && fail "released an empty Unreleased section"
grep -q 'Unreleased section is empty' <<<"$err" || fail "unclear empty-changelog message: $err"
eq "empty: status" "$(git -C "$repo" status --porcelain --untracked-files=no)" ""
eq "empty: tags" "$(git -C "$repo" tag -l)" ""
cp "$work/changelog.keep" "$repo/CHANGELOG.md"
git -C "$repo" commit -q -am "Restore Unreleased"
git -C "$repo" push -q origin main
base=$(git -C "$repo" rev-parse HEAD)
[ "$base" != "$base2" ] || fail "fixture commit missing"

# Success. An untracked file doesn't count as uncommitted changes.
touch "$repo/untracked.txt"
out=$(release 0.1.0-alpha.1 2>&1) || fail "release failed: $out"
grep -qxF '  git push origin main v0.1.0-alpha.1' <<<"$out" || fail "no push command in the output: $out"
eq subject "$(git -C "$repo" log -1 --format=%s)" "Release 0.1.0-alpha.1"
eq parent "$(git -C "$repo" rev-parse HEAD~1)" "$base"
eq tag-type "$(git -C "$repo" cat-file -t v0.1.0-alpha.1)" tag
eq tag-target "$(git -C "$repo" rev-parse 'v0.1.0-alpha.1^{commit}')" "$(git -C "$repo" rev-parse HEAD)"
eq tag-message "$(git -C "$repo" tag -l --format='%(contents:subject)' v0.1.0-alpha.1)" "GitBolt 0.1.0-alpha.1"
eq committed-files "$(git -C "$repo" diff --name-only HEAD~1 HEAD | tr '\n' ' ')" \
  'CHANGELOG.md Cargo.lock Cargo.toml crates/gitbolt-app/tauri.conf.json ui/package-lock.json ui/package.json '
eq status-after "$(git -C "$repo" status --porcelain)" '?? untracked.txt'
eq tauri-conf "$(jq -r .version "$repo/crates/gitbolt-app/tauri.conf.json")" 0.1.0-alpha.1
eq workspace "$(python3 -c 'import tomllib,sys; print(tomllib.load(open(sys.argv[1],"rb"))["workspace"]["package"]["version"])' "$repo/Cargo.toml")" 0.1.0-alpha.1
eq ui-package "$(jq -r .version "$repo/ui/package.json")" 0.1.0-alpha.1
eq ui-lock "$(jq -r '.version + " " + .packages[""].version' "$repo/ui/package-lock.json")" '0.1.0-alpha.1 0.1.0-alpha.1'
# Cargo.lock: exactly the workspace members' versions changed (one line each), nothing else.
lockdiff=$(git -C "$repo" diff -U0 HEAD~1 HEAD -- Cargo.lock | grep -E '^[-+][^-+]' | sort | uniq -c | sed 's/^ *//')
eq cargo-lock "$lockdiff" "$(printf '4 +version = "0.1.0-alpha.1"\n4 -version = "%s"' "$old")"
for m in gitbolt-app gitbolt-core gitbolt-forge gitbolt-harness; do
  grep -A1 -xF "name = \"$m\"" "$repo/Cargo.lock" | grep -qxF 'version = "0.1.0-alpha.1"' || fail "Cargo.lock: $m not bumped"
done
# Each JSON/TOML edit changed only the version line.
for f in Cargo.toml crates/gitbolt-app/tauri.conf.json ui/package.json; do
  eq "$f diff" "$(git -C "$repo" diff -U0 HEAD~1 HEAD -- "$f" | grep -cE '^[-+][^-+]')" 2
done
eq ui-lock-diff "$(git -C "$repo" diff -U0 HEAD~1 HEAD -- ui/package-lock.json | grep -cE '^[-+][^-+]')" 4
grep -qxF "## [0.1.0-alpha.1] - $(date +%F)" "$repo/CHANGELOG.md" || fail "no release heading in CHANGELOG.md"
eq release-notes "$(python3 "$repo/scripts/changelog.py" notes 0.1.0-alpha.1 "$repo/CHANGELOG.md")" "$(printf '### Fixed\n\n- A release-test fix.')"
grep -A2 -xF '## [Unreleased]' "$repo/CHANGELOG.md" | sed -n 3p | grep -qxF "## [0.1.0-alpha.1] - $(date +%F)" || fail "Unreleased isn't right above the new section"
# Never pushed: the remote has neither the tag nor the commit.
eq remote-tags "$(git -C "$work/origin.git" tag -l)" ""
eq remote-main "$(git -C "$work/origin.git" rev-parse main)" "$base"

# A second release needs a newer version, and its own changelog entry.
release 0.1.0-alpha.1 >/dev/null 2>&1 && fail "released the same version twice"
git -C "$repo" push -q origin main
python3 - "$repo/CHANGELOG.md" <<'EOF'
import sys
p = sys.argv[1]
s = open(p).read().replace("## [Unreleased]\n", "## [Unreleased]\n\n- Another fix.\n", 1)
open(p, "w").write(s)
EOF
git -C "$repo" commit -q -am "Another fix"
git -C "$repo" push -q origin main
err=$(release 0.1.0-alpha.0 2>&1) && fail "released an older version"
grep -q 'not newer than v0.1.0-alpha.1' <<<"$err" || fail "unclear older-version message: $err"
eq older-status "$(git -C "$repo" status --porcelain --untracked-files=no)" ""
release 0.1.0-beta.1 >/dev/null || fail "the second release failed"
eq second-tag "$(git -C "$repo" tag -l | tr '\n' ' ')" 'v0.1.0-alpha.1 v0.1.0-beta.1 '

# --- package-version.sh -------------------------------------------------------------------------
pv() { (cd "$repo" && scripts/package-version.sh crates/gitbolt-app/tauri.conf.json); }
stamped=$(env -u GITBOLT_RELEASE_VERSION bash -c "cd '$repo' && scripts/package-version.sh crates/gitbolt-app/tauri.conf.json")
[[ $stamped =~ ^0\.1\.0-beta\.1\+[0-9]{12}\.[0-9a-f]{7,}$ ]] || fail "local builds aren't stamped: $stamped"
[[ $stamped == *".$(git -C "$repo" rev-parse --short HEAD)" ]] || fail "the stamp lacks the commit: $stamped"
eq release-version "$(GITBOLT_RELEASE_VERSION=0.1.0-beta.1 pv)" 0.1.0-beta.1
err=$(GITBOLT_RELEASE_VERSION=0.1.0-beta.2 pv 2>&1) && fail "a release version unlike tauri.conf.json was accepted"
grep -q "doesn't match tauri.conf.json" <<<"$err" || fail "unclear mismatch message: $err"
GITBOLT_RELEASE_VERSION=0.1 pv >/dev/null 2>&1 && fail "an invalid release version was accepted"

echo "test-release: OK"
