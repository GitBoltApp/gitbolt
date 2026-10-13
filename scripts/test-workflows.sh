#!/usr/bin/env bash
# Self-test for .github/workflows/: every action pinned by commit with its version as a comment,
# every workflow starting from no permissions (each job asks for what it needs, never write-all),
# every checkout without persisted credentials, no pull_request_target, no secret but the
# workflow's own token (nor all of them, through secrets[...] or toJSON(secrets)) and no forced
# refspec (+HEAD:, +refs/); the site's deploy only from main and its downloads never force-pushed;
# then actionlint (with shellcheck on the run: scripts) over the site's workflows, when it's
# installed.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
wf=$(cd "$here/../.github/workflows" && pwd)
fail() { echo "test-workflows: FAIL: $*" >&2; exit 1; }

for f in "$wf"/*.yml; do
  name=$(basename "$f")
  grep -qx 'permissions: {}' "$f" || fail "$name: no top-level 'permissions: {}'"
  if grep -qE '^[[:space:]]*permissions:[[:space:]]*write-all' "$f"; then fail "$name: a job asks for write-all"; fi
  unpinned=$(grep -nE '^[[:space:]]*(- )?uses:' "$f" | grep -vE 'uses: [A-Za-z0-9_.-]+/[A-Za-z0-9_./-]+@[0-9a-f]{40} # [^ ]+$' || true)
  [ -z "$unpinned" ] || fail "$name: actions not pinned by commit with a version comment: $unpinned"
  checkouts=$(grep -cE 'uses: actions/checkout@' "$f" || true)
  unpersisted=$(grep -cE '^[[:space:]]*persist-credentials: false$' "$f" || true)
  [ "$checkouts" = "$unpersisted" ] || fail "$name: $checkouts checkouts, $unpersisted with persist-credentials: false"
  if grep -q 'pull_request_target' "$f"; then fail "$name: pull_request_target runs fork code with a write token"; fi
  others=$(grep -oE 'secrets\.[A-Za-z0-9_]+' "$f" | grep -vx 'secrets.GITHUB_TOKEN' || true)
  [ -z "$others" ] || fail "$name: secrets other than GITHUB_TOKEN: $others"
  if grep -qiE 'secrets[[:space:]]*\[|tojson\([[:space:]]*secrets' "$f"; then fail "$name: reads secrets by index or all at once"; fi
  if grep -qE '[[:space:]]["'"'"']?\+(HEAD|refs/)' "$f"; then fail "$name: pushes a forced refspec (+HEAD: or +refs/)"; fi
done

site=$wf/site.yml
release=$wf/site-release.yml
[ -f "$site" ] && [ -f "$release" ] || fail "site.yml or site-release.yml is missing"
grep -q "if: github.ref == 'refs/heads/main'" "$site" || fail "site.yml: the deploy isn't limited to main"
grep -q 'name: github-pages' "$site" || fail "site.yml: the deploy isn't in the github-pages environment"
if grep -qE 'pull_request' "$site" "$release"; then fail "the site's workflows run on pull requests"; fi
grep -q 'gh workflow run site.yml --ref main' "$release" || fail "site-release.yml: doesn't start the deploy on main"
if grep -qE 'push .*(-f|--force)' "$release"; then fail "site-release.yml: force-pushes"; fi

if command -v actionlint >/dev/null 2>&1; then
  actionlint "$site" "$release"
else
  echo "test-workflows: actionlint isn't installed; skipped linting the site's workflows"
fi
echo "test-workflows: OK"
