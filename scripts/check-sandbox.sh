#!/usr/bin/env bash
# Usage: scripts/check-sandbox.sh — asserts every renderer of the running GitBolt is sandboxed:
# seccomp-bpf on (`Seccomp: 2`) and its own PID namespace (`NSpid` lists two PIDs). Both come from
# /proc/<pid>/status, which stays readable for non-dumpable sandboxed processes.
set -euo pipefail
. "$(dirname "$0")/proc-tree.sh"
pids=$(gitbolt_pids)
n=0; bad=0
for p in $pids; do
  case "$(gitbolt_role "$p")" in *renderer*) ;; *) continue ;; esac
  n=$((n + 1))
  seccomp=$(awk '/^Seccomp:/ {print $2}' "/proc/$p/status")
  ns=$(awk '/^NSpid:/ {print NF - 1}' "/proc/$p/status")
  if [ "$seccomp" = 2 ] && [ "$ns" -ge 2 ]; then
    echo "$p sandboxed (seccomp=$seccomp, pid namespaces=$ns)"
  else
    echo "$p NOT sandboxed (seccomp=$seccomp, pid namespaces=$ns)"; bad=$((bad + 1))
  fi
done
[ "$n" -gt 0 ] || { echo "check-sandbox: no renderer found" >&2; exit 1; }
[ "$bad" -eq 0 ] || { echo "check-sandbox: $bad renderer(s) unsandboxed" >&2; exit 1; }
echo "check-sandbox: OK ($n renderer(s))"
