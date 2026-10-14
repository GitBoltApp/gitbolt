#!/usr/bin/env bash
# Self-test for scripts/site-release.py, the website's downloads (site/data/release.json): which
# release it picks, the packages it lists, and what it refuses. Fictional releases only.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
fail() { echo "test-site-release: FAIL: $*" >&2; exit 1; }
eq() { [ "$2" = "$3" ] || fail "$1: expected '$3', got '$2'"; }
sr() { python3 "$here/site-release.py" "$@"; }
# fails <expected message part> <args…>: the command exits non-zero with that on stderr.
fails() {
  local want=$1 err
  shift
  if err=$(sr "$@" 2>&1 >/dev/null); then fail "accepted: $*"; fi
  grep -qF -- "$want" <<<"$err" || fail "unclear error for $*: $err"
}
h() { printf '%064d' "$1"; } # a fake SHA-256
work=$(mktemp -d); trap 'rm -rf "$work"' EXIT

cat > "$work/releases.json" <<EOF
[
  {"tag_name": "v2.0.0", "draft": true, "prerelease": false, "published_at": null, "assets": []},
  {"tag_name": "v1.2.0-rc.1", "draft": false, "prerelease": true, "published_at": "2026-03-02T10:00:00Z", "assets": [
    {"name": "GitVolt-1.2.0rc.1-1-x86_64.pkg.tar.zst", "size": 30, "digest": "sha256:$(h 21)"},
    {"name": "SHA256SUMS", "size": 9, "digest": null}]},
  {"tag_name": "v0.9.1", "draft": false, "prerelease": false, "published_at": "2026-02-20T10:00:00Z", "assets": []},
  {"tag_name": "nightly", "draft": false, "prerelease": true, "published_at": "2026-02-19T10:00:00Z", "assets": []},
  {"tag_name": "v1.1.0", "draft": false, "prerelease": false, "published_at": "2026-02-01T10:00:00Z", "assets": [
    {"name": "GitVolt_1.1.0_amd64.deb", "size": 11, "digest": "sha256:$(h 1)"},
    {"name": "GitVolt-1.1.0-1.x86_64.rpm", "size": 12, "digest": "sha256:$(h 2)"},
    {"name": "GitVolt-1.1.0-1-x86_64.pkg.tar.zst", "size": 13, "digest": null},
    {"name": "GitVolt_1.1.0_aarch64.dmg", "size": 14, "digest": "sha256:$(h 4)"},
    {"name": "GitVolt_1.1.0_x64-setup.exe", "size": 15, "digest": "sha256:$(h 5)"},
    {"name": "GitVolt_1.1.0_x64.msi", "size": 16, "digest": "sha256:$(h 6)"},
    {"name": "notes.txt", "size": 17, "digest": "sha256:$(h 7)"},
    {"name": "SHA256SUMS", "size": 18, "digest": "sha256:$(h 8)"}]},
  {"tag_name": "v1.0.0", "draft": false, "prerelease": false, "published_at": "2026-01-01T10:00:00Z", "assets": [
    {"name": "SHA256SUMS", "size": 1, "digest": null}]}
]
EOF
cat > "$work/SHA256SUMS" <<EOF
$(h 1)  GitVolt_1.1.0_amd64.deb
$(h 2)  GitVolt-1.1.0-1.x86_64.rpm
$(h 3)  GitVolt-1.1.0-1-x86_64.pkg.tar.zst
$(h 4)  GitVolt_1.1.0_aarch64.dmg
$(h 5) *GitVolt_1.1.0_x64-setup.exe
$(h 6)  GitVolt_1.1.0_x64.msi
EOF

# --- pick: the newest release by SemVer that isn't a pre-release, not the last one published.
eq pick-stable "$(sr pick "$work/releases.json")" v1.1.0
eq pick-tag "$(sr pick "$work/releases.json" v1.2.0-rc.1)" v1.2.0-rc.1
fails "v2.0.0 isn't a published release" pick "$work/releases.json" v2.0.0
fails "nightly isn't a published release" pick "$work/releases.json" nightly
jq '[.[] | select(.prerelease)]' "$work/releases.json" > "$work/pre.json"
eq pick-only-pre "$(sr pick "$work/pre.json")" v1.2.0-rc.1
echo '[]' > "$work/none.json"
eq pick-none "$(sr pick "$work/none.json")" ''

# --- write: every package the release has, in the site's order, with its size and checksum.
sr write ExampleOrg/example "$work/releases.json" v1.1.0 "$work/SHA256SUMS" > "$work/out.json"
eq kinds "$(jq -r '[.release.downloads[].kind] | join(" ")' "$work/out.json")" "deb rpm arch dmg nsis msi"
eq header "$(jq -c '{schema, release: (.release | del(.downloads))}' "$work/out.json")" \
  '{"schema":1,"release":{"version":"1.1.0","tag":"v1.1.0","prerelease":false,"published":"2026-02-01T10:00:00Z","url":"https://github.com/ExampleOrg/example/releases/tag/v1.1.0","sums":"https://github.com/ExampleOrg/example/releases/download/v1.1.0/SHA256SUMS"}}'
eq deb "$(jq -c '.release.downloads[0]' "$work/out.json")" \
  "{\"os\":\"linux\",\"kind\":\"deb\",\"arch\":\"x86_64\",\"file\":\"GitVolt_1.1.0_amd64.deb\",\"url\":\"https://github.com/ExampleOrg/example/releases/download/v1.1.0/GitVolt_1.1.0_amd64.deb\",\"bytes\":11,\"sha256\":\"$(h 1)\"}"
eq arch-no-digest "$(jq -r '.release.downloads[2].sha256' "$work/out.json")" "$(h 3)"
eq nsis-binary-mark "$(jq -r '.release.downloads[4].sha256' "$work/out.json")" "$(h 5)"
eq dmg "$(jq -c '.release.downloads[3] | [.os, .arch]' "$work/out.json")" '["macos","aarch64"]'
sr write ExampleOrg/example "$work/releases.json" v1.1.0 "$work/SHA256SUMS" > "$work/again.json"
cmp -s "$work/out.json" "$work/again.json" || fail "write isn't byte-stable"
[ "$(tail -c 1 "$work/out.json" | od -An -tx1 | tr -d ' ')" = 0a ] || fail "write doesn't end with a newline"

# A pre-release: the Arch package's name drops the '-', and it says it's a pre-release.
echo "$(h 21)  GitVolt-1.2.0rc.1-1-x86_64.pkg.tar.zst" > "$work/SUMS-rc"
sr write ExampleOrg/example "$work/releases.json" v1.2.0-rc.1 "$work/SUMS-rc" > "$work/rc.json"
eq rc "$(jq -c '[.release.prerelease, [.release.downloads[].file]]' "$work/rc.json")" '[true,["GitVolt-1.2.0rc.1-1-x86_64.pkg.tar.zst"]]'

# --- what it refuses
grep -v msi "$work/SHA256SUMS" > "$work/SUMS-no-msi"
fails "GitVolt_1.1.0_x64.msi isn't in v1.1.0's SHA256SUMS" write ExampleOrg/example "$work/releases.json" v1.1.0 "$work/SUMS-no-msi"
sed "s/^$(h 1)/$(h 9)/" "$work/SHA256SUMS" > "$work/SUMS-bad"
fails "GitVolt_1.1.0_amd64.deb: SHA256SUMS says $(h 9), GitHub says sha256:$(h 1)" write ExampleOrg/example "$work/releases.json" v1.1.0 "$work/SUMS-bad"
fails "v0.9.1 has no SHA256SUMS" write ExampleOrg/example "$work/releases.json" v0.9.1 "$work/SHA256SUMS"
fails "v1.0.0 has none of the packages docs/releasing.md names" write ExampleOrg/example "$work/releases.json" v1.0.0 "$work/SHA256SUMS"
fails "v2.0.0 isn't a published release" write ExampleOrg/example "$work/releases.json" v2.0.0 "$work/SHA256SUMS"
fails "isn't an owner/name" write 'not a repo' "$work/releases.json" v1.1.0 "$work/SHA256SUMS"
echo nonsense > "$work/SUMS-junk"
fails "not a sha256sum line" write ExampleOrg/example "$work/releases.json" v1.1.0 "$work/SUMS-junk"
echo '{}' > "$work/object.json"
fails "expected a JSON array of releases" pick "$work/object.json"

fails "isn't an owner/name" write ../.. "$work/releases.json" v1.1.0 "$work/SHA256SUMS"
fails "isn't an owner/name" write ExampleOrg/.. "$work/releases.json" v1.1.0 "$work/SHA256SUMS"
cat "$work/SHA256SUMS" "$work/SHA256SUMS" > "$work/SUMS-dup"
fails "is listed twice" write ExampleOrg/example "$work/releases.json" v1.1.0 "$work/SUMS-dup"
jq "map(if .tag_name == \"v1.1.0\" then .assets[0].digest |= ascii_upcase | .assets[0].digest |= sub(\"SHA256\"; \"sha256\") else . end)" "$work/releases.json" > "$work/upper.json"
sr write ExampleOrg/example "$work/upper.json" v1.1.0 "$work/SHA256SUMS" > /dev/null || fail "upper-case digest refused"
jq 'map(if .tag_name == "v1.1.0" then .assets[0] |= del(.size) else . end)' "$work/releases.json" > "$work/nosize.json"
fails "has no size" write ExampleOrg/example "$work/nosize.json" v1.1.0 "$work/SHA256SUMS"
jq 'map(if .tag_name == "v1.1.0" then .published_at = null else . end)' "$work/releases.json" > "$work/nodate.json"
fails "has no published_at" write ExampleOrg/example "$work/nodate.json" v1.1.0 "$work/SHA256SUMS"
echo '[{"tag_name":"v0.9.0","assets":[]},{"tag_name":"v0.10.0","assets":[]}]' > "$work/ord.json"
eq order-minor "$(sr pick "$work/ord.json")" v0.10.0
echo '[{"tag_name":"v1.0.0-rc.10","prerelease":true,"assets":[]},{"tag_name":"v1.0.0-rc.2","prerelease":true,"assets":[]}]' > "$work/ord2.json"
eq order-rc "$(sr pick "$work/ord2.json")" v1.0.0-rc.10

# --- empty: no release yet
eq empty "$(sr empty | jq -c .)" '{"schema":1,"release":null}'

echo "test-site-release: OK"
