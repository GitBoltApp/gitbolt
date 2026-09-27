#!/usr/bin/env bash
# Usage: ./measure-idle.sh [seconds] — average CPU% of gitbolt and ALL its CEF processes over
# the window, with a per-PID breakdown (ticks + cpu%) that sums to the total. Adapted from the
# CEF spike's measure-idle.sh (spike-cef/measure-idle.sh); only process discovery differs (see
# proc-tree.sh). A PID that exits during the window is reported as "(exited)" with 0 ticks.
set -euo pipefail
. "$(dirname "$0")/proc-tree.sh"
secs=${1:-60}
pids=$(gitbolt_pids | tr '\n' ' ')
ticks_of() { [ -r "/proc/$1/stat" ] && awk '{print $14+$15}' "/proc/$1/stat" 2>/dev/null || echo ""; }
comm_of() { gitbolt_role "$1"; }

declare -A t0 name
for p in $pids; do t0[$p]=$(ticks_of "$p"); name[$p]=$(comm_of "$p"); done
sleep "$secs"

hz=$(getconf CLK_TCK)
total=0
echo "pids: $pids"
printf "%-8s %-60s %8s %8s\n" "PID" "process role" "ticks" "cpu%"
for p in $pids; do
  t1=$(ticks_of "$p")
  if [ -z "$t1" ] || [ -z "${t0[$p]}" ]; then d=0; label="(exited) ${name[$p]}"; else d=$((t1 - t0[$p])); label=${name[$p]}; fi
  total=$((total + d))
  cpu=$(awk -v d="$d" -v hz="$hz" -v s="$secs" 'BEGIN { printf "%.3f", 100*d/hz/s }')
  printf "%-8s %-60s %8s %8s\n" "$p" "${label:0:60}" "$d" "$cpu"
done
awk -v a="$total" -v hz="$hz" -v s="$secs" 'BEGIN { printf "avg cpu%%: %.3f (sum of the per-PID rows above)\n", 100*a/hz/s }'
