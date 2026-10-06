#!/usr/bin/env bash
# Usage: scripts/package-version.sh <tauri.conf.json>  (`just package`)
#
# Prints the version a package build gets. Local builds: tauri.conf.json's version with a build
# stamp, <version>+<UTC YYYYMMDDHHMM>.<short commit>, so each build is newer than the last and
# `apt install` replaces the installed one. Release builds set GITBOLT_RELEASE_VERSION, which must
# be a valid release version (scripts/version.py) equal to tauri.conf.json's: the plain version.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
conf=${1:?usage: package-version.sh <tauri.conf.json>}
v=$(jq -er .version "$conf")
if [ -n "${GITBOLT_RELEASE_VERSION:-}" ]; then
  python3 "$here/version.py" check "$GITBOLT_RELEASE_VERSION" || exit 1
  [ "$GITBOLT_RELEASE_VERSION" = "$v" ] || {
    echo "package-version: GITBOLT_RELEASE_VERSION=$GITBOLT_RELEASE_VERSION doesn't match tauri.conf.json's $v" >&2
    exit 1
  }
  echo "$v"
else
  echo "$v+$(date -u +%Y%m%d%H%M).$(git -C "$(dirname "$conf")" rev-parse --short HEAD)"
fi
