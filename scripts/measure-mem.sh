#!/usr/bin/env bash
# Usage: ./measure-mem.sh — total PSS (MB) of gitbolt and ALL of its CEF processes (browser,
# zygotes, renderers, GPU, utility/network, setuid sandbox helper). Adapted from the CEF spike's
# measure-mem.sh (spike-cef/measure-mem.sh); process discovery differs because CEF re-executes
# the app binary for every helper (see proc-tree.sh).
#
# CAVEAT: under Chromium's setuid sandbox, renderers (and the sandbox helper) are non-dumpable,
# so smaps_rollup is unreadable to the user. Such rows are printed as "PSS unreadable" and NOT
# silently counted as 0; the total then says how many were missing. RSS (from
# /proc/<pid>/status, which stays readable) is printed for every row as a cross-check (RSS
# double-counts shared pages, so its sum is an upper bound, not comparable to PSS).
set -euo pipefail
. "$(dirname "$0")/proc-tree.sh"
pids=$(gitbolt_pids) || { echo "measure-mem.sh: no gitbolt process found" >&2; exit 1; }
if [ -z "$pids" ]; then
  echo "measure-mem.sh: no gitbolt process found" >&2
  exit 1
fi
total=0; missing=0; rss_total=0
for p in $pids; do
  rss=$(awk '/^VmRSS:/ {print $2}' "/proc/$p/status" 2>/dev/null || echo 0)
  rss_total=$((rss_total + ${rss:-0}))
  if kb=$(awk '/^Pss:/ {print $2}' "/proc/$p/smaps_rollup" 2>/dev/null) && [ -n "$kb" ]; then
    total=$((total + kb)); pss="${kb}kB"
  else
    missing=$((missing + 1)); pss="PSS unreadable"
  fi
  echo "$p [$(gitbolt_role "$p")] PSS=$pss RSS=${rss}kB"
done
echo "total PSS: $((total / 1024)) MB ($missing process(es) with unreadable PSS not included); sum RSS: $((rss_total / 1024)) MB"
