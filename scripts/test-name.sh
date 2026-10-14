#!/usr/bin/env bash
# The old name, GitBolt (before 0.7.0; another project's name too), stays in the files listed in
# scripts/name-allowlist.txt: the rename's notes and the code that takes over what GitBolt left.
# Any other tracked file that has it fails, with its lines.
set -euo pipefail
cd "$(dirname "$0")/.."
allow=scripts/name-allowlist.txt
bad=$(git grep -l -I -i -E 'git[ -]?bolt' -- . ":(exclude)$allow" | grep -vxF -f <(grep -v -e '^#' -e '^$' "$allow") || true)
if [ -n "$bad" ]; then
  echo "test-name: FAIL: the old name outside $allow:" >&2
  while read -r f; do git grep -n -I -i -E 'git[ -]?bolt' -- "$f" >&2; done <<<"$bad"
  exit 1
fi
echo "test-name: OK"
