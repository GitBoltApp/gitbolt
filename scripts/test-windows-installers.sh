#!/usr/bin/env bash
# Static checks of the Windows installers' sources (they build only on Windows: package-windows.ps1).
# The MSI keeps GitBolt's UpgradeCode (the app's name before 0.7.0), so it upgrades GitBolt's MSI in
# place; the NSIS installer runs GitBolt's per-user uninstaller.
set -euo pipefail
root=$(cd "$(dirname "$0")/.." && pwd)
fail() { echo "test-windows-installers: FAIL: $*" >&2; exit 1; }
wxs="$root/packaging/windows/gitvolt.wxs"
nsi="$root/packaging/windows/gitvolt.nsi"
grep -qF 'UpgradeCode="7003EA59-7995-4744-BA0C-D01FB85D7BBA"' "$wxs" || fail "the MSI's UpgradeCode changed: GitBolt's MSI wouldn't be upgraded"
grep -qF '<MajorUpgrade ' "$wxs" || fail "the MSI has no MajorUpgrade"
grep -qF '!define LEGACY_UNINSTALL_KEY "Software\Microsoft\Windows\CurrentVersion\Uninstall\GitBolt"' "$nsi" || fail "the installer doesn't look for GitBolt's install"
grep -qF 'uninstall.exe" /S _?=$1' "$nsi" || fail "the installer doesn't run GitBolt's uninstaller silently"
grep -qE 'ExecWait .*\$1.*KEEPREG' "$nsi" && fail "GitBolt's uninstaller must not keep its registry entries"
grep -qE '^  ExecWait .*uninstall\.exe" /S _\?=\$1.* \$2$' "$nsi" || fail "the installer doesn't check GitBolt's uninstaller's exit code"
grep -qF 'FileOpen $2 "$1\GitBolt.exe" a' "$nsi" || fail "the installer doesn't check for a running GitBolt"
grep -qF 'GitBolt is running. Close it, then click Retry.' "$nsi" || fail "the installer doesn't ask to close a running GitBolt"
[ "$(grep -cF 'IntCmp $3 20 ' "$nsi")" = 2 ] || fail "the installers don't wait for a quitting app before asking (GitBolt's and GitVolt's)"
echo "test-windows-installers: OK"
