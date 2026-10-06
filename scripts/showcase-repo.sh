#!/usr/bin/env bash
# Build the showcase repos the README screenshot is taken of (`just readme-screenshot`):
#
#   scripts/showcase-repo.sh DIR
#
# DIR/driftwood is a fictional read-later app with about 200 commits by eight people over five
# months: `main` and a long-lived `develop`, feature branches merged back with merge commits,
# release branches tagged v0.1.0 to v1.2.0, a hotfix merged into both, branches still open, a
# local bare `origin` (DIR/.remotes) that some branches are ahead of or behind, a stash and
# uncommitted changes. DIR/docs-site, DIR/infra and DIR/mobile-app are small repos for the other
# tabs. Every name, email and repo is made up.
#
# Deterministic: fixed identities, dates and contents, git config isolated from yours, so every
# run gives the same commit hashes. Re-running resets DIR, which must be empty, missing, or carry
# the .gitbolt-showcase marker from a previous run.
set -euo pipefail
dir=${1:?usage: scripts/showcase-repo.sh DIR}
marker=.gitbolt-showcase

if [ -e "$dir" ] && [ -n "$(ls -A "$dir")" ] && [ ! -f "$dir/$marker" ]; then
  echo "$dir isn't empty and has no $marker marker; leaving it alone" >&2
  exit 1
fi
rm -rf "${dir:?}/driftwood" "${dir:?}/docs-site" "${dir:?}/infra" "${dir:?}/mobile-app" "${dir:?}/.remotes"
mkdir -p "$dir/.remotes"
touch "$dir/$marker"
dir=$(cd "$dir" && pwd)

# Nothing from the user's git config: no signing, hooks, templates or default branch.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 GIT_TEMPLATE_DIR= TZ=UTC LC_ALL=C
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE

declare -A NAME=(
  [maya]="Maya Okafor" [tomas]="Tomás Lindqvist" [priya]="Priya Raman" [jonah]="Jonah Whitfield"
  [elena]="Elena Varga" [kenji]="Kenji Morimoto" [sofia]="Sofia Brandt" [luca]="Luca Ferraro"
)
declare -A EMAIL=(
  [maya]="maya@example.com" [tomas]="tomas@example.org" [priya]="priya.raman@example.com" [jonah]="jonah@example.org"
  [elena]="elena.varga@example.com" [kenji]="kenji@example.org" [sofia]="sofia@example.com" [luca]="luca.ferraro@example.org"
)
declare -A ZONE=(
  [maya]="+0100" [tomas]="+0200" [priya]="+0530" [jonah]="-0500"
  [elena]="+0200" [kenji]="+0900" [sofia]="+0200" [luca]="+0100"
)

# The clock: each commit moves it forward by a pseudo-random 1 to 21 hours (a fixed LCG, so the
# same every run); `at` jumps to the start of a phase.
clock=0
seed=20260504
tick() {
  seed=$(( (seed * 1103515245 + 12345) % 2147483648 ))
  clock=$(( clock + 3600 + (seed / 7) % (20 * 3600) ))
}
at() {
  local t
  t=$(date -u -d "$1" +%s)
  (( t > clock )) && clock=$t
  return 0
}

# Runs git as person $1 at the current clock.
as() {
  local who=$1; shift
  GIT_AUTHOR_NAME=${NAME[$who]} GIT_AUTHOR_EMAIL=${EMAIL[$who]} GIT_AUTHOR_DATE="$clock ${ZONE[$who]}" \
  GIT_COMMITTER_NAME=${NAME[$who]} GIT_COMMITTER_EMAIL=${EMAIL[$who]} GIT_COMMITTER_DATE="$clock ${ZONE[$who]}" \
    git "$@"
}

new_repo() {
  git init -q -b main "$1"
  cd "$1"
  git config commit.gpgsign false
  git config tag.gpgSign false
  git config user.name "Showcase"
  git config user.email "showcase@example.invalid"
}

sw() { [ "$(git symbolic-ref --short HEAD)" = "$1" ] || git switch -q "$1"; }
br() { git branch "$1" "$2"; }

# lowerCamelCase of a message's first four words: a function name for `edit`.
ident() {
  echo "$1" | tr -cd 'A-Za-z0-9 ' | awk '{ s = tolower($1); for (i = 2; i <= NF && i <= 4; i++) s = s toupper(substr($i, 1, 1)) tolower(substr($i, 2)); print s }'
}

# A small change to file $1 for commit message $2, in the file's own syntax.
edit() {
  local f=$1 msg=$2
  mkdir -p "$(dirname "$f")"
  case "$f" in
    *.ts|*.tsx|*.js)
      printf '\nexport function %s() {\n  // %s\n  return null;\n}\n' "$(ident "$msg")" "$msg" >> "$f" ;;
    *.md) printf -- '- %s\n' "$msg" >> "$f" ;;
    *.sql) printf -- '-- %s\nALTER TABLE bookmarks ADD COLUMN %s TEXT;\n' "$msg" "$(ident "$msg" | tr 'A-Z' 'a-z' | cut -c1-24)" >> "$f" ;;
    *.css) printf '\n/* %s */\n.%s {\n  display: block;\n}\n' "$msg" "$(ident "$msg")" >> "$f" ;;
    *.html) printf '<!-- %s -->\n' "$msg" >> "$f" ;;
    *.tf) printf '\n# %s\nresource "null_resource" "%s" {}\n' "$msg" "$(ident "$msg")" >> "$f" ;;
    *) printf '# %s\n' "$msg" >> "$f" ;;
  esac
}

# c BRANCH WHO MESSAGE FILE...: edit each file on BRANCH and commit them.
c() {
  local b=$1 who=$2 msg=$3; shift 3
  sw "$b"
  local f
  for f in "$@"; do edit "$f" "${msg%%$'\n'*}"; done
  git add -A
  tick
  as "$who" commit -q -m "$msg"
}

# m INTO FROM WHO: a merge commit (git's own message), never a fast-forward.
m() {
  sw "$1"
  tick
  as "$3" merge -q --no-ff --no-edit "$2"
}

# release BRANCH VERSION: the version bump that opens a release branch.
bump() {
  sw "$1"
  sed -i "s/\"version\": \"[^\"]*\"/\"version\": \"$2\"/" package.json
  git add package.json
  tick
  as maya commit -q -m "Bump version to $2"
}

# changelog BRANCH VERSION NOTE...: the release's changelog section, newest on top.
changelog() {
  local b=$1 v=$2; shift 2
  sw "$b"
  tick
  { head -n 2 CHANGELOG.md; printf '## %s (%s)\n\n' "$v" "$(date -u -d "@$clock" +%F)"; printf -- '- %s\n' "$@"; echo; tail -n +3 CHANGELOG.md; } > CHANGELOG.new
  mv CHANGELOG.new CHANGELOG.md
  git add CHANGELOG.md
  as maya commit -q -m "Update the changelog for $v"
}

# ship RELEASE VERSION: merge a release (or hotfix) branch into main, tag it, merge it back into
# develop and delete it.
ship() {
  m main "$1" maya
  as maya tag -a "v$2" -m "Driftwood $2"
  m develop "$1" maya
  git branch -q -d "$1"
}

# done_with BRANCH: a merged branch is deleted, as it would be after review.
done_with() { git branch -q -d "$@"; }

# --- driftwood -------------------------------------------------------------------------------

at "2026-05-04 08:40"
new_repo "$dir/driftwood"

cat > README.md <<'EOF'
# Driftwood

A small, self-hosted read-later service: save links from the browser, tag them, search them,
and read a clean copy even after the original page is gone.

EOF
cat > package.json <<'EOF'
{
  "name": "driftwood",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p . && vite build web",
    "test": "vitest run"
  }
}
EOF
printf '# Changelog\n\n' > CHANGELOG.md
printf 'node_modules/\ndist/\n*.db\n.env\n' > .gitignore
git add -A
tick; as maya commit -q -m "Initial commit"

c main maya "Add an HTTP server skeleton" src/server.ts src/config.ts
c main tomas "Store bookmarks in SQLite" src/db/schema.sql src/db/index.ts
c main maya "Add bookmark routes" src/routes/bookmarks.ts tests/bookmarks.test.ts
c main priya "Add the bookmark list page" web/App.tsx web/components/BookmarkList.tsx web/styles.css
c main tomas "Fetch page titles when a link is saved" src/fetch/title.ts
c main maya "Document local setup in the README" README.md
bump main 0.1.0
changelog main 0.1.0 "First release: save, list and open bookmarks."
as maya tag -a v0.1.0 -m "Driftwood 0.1.0"
br develop main

# 0.2.0: tags and search.
at "2026-05-14 09:00"
br feature/tags develop
br feature/search develop
c feature/tags tomas "Add a tags table and model" src/db/schema.sql src/tags/model.ts
c feature/search priya "Index titles and notes for full-text search" src/search/index.ts src/db/fts.sql
c feature/tags tomas "Expose tag endpoints" src/tags/routes.ts src/server.ts
c develop maya "Add an .editorconfig" .editorconfig
c develop maya "Configure ESLint" eslint.config.js
c feature/search priya "Split URLs into searchable words" src/search/tokenize.ts
c feature/tags jonah "Add the TagPicker component" web/components/TagPicker.tsx web/styles.css
c feature/search kenji "Add a search bar to the header" web/components/SearchBar.tsx web/components/SearchBar.css
c feature/tags jonah "Show tags on bookmark cards" web/components/BookmarkList.tsx
c feature/tags tomas "Rename tags in place" src/tags/routes.ts src/tags/model.ts
c feature/tags tomas "Test the tag routes" tests/tags.test.ts
m develop feature/tags maya
c feature/search priya "Debounce the search input" web/components/SearchBar.tsx
c feature/search kenji "Highlight matches in results" web/components/SearchResults.tsx
br fix/favicon-fetch develop
c fix/favicon-fetch luca "Fall back to /favicon.ico when a page has no icon link" src/fetch/favicon.ts
c feature/search priya "Rank results by recency and match count" src/search/rank.ts
c fix/favicon-fetch luca "Time out favicon requests after 3 seconds" src/fetch/favicon.ts tests/favicon.test.ts
m develop fix/favicon-fetch maya
c feature/search kenji "Test search ranking" tests/search.test.ts
m develop feature/search maya
done_with feature/tags feature/search fix/favicon-fetch
br release/0.2.0 develop
bump release/0.2.0 0.2.0
c develop elena "Add architecture notes" docs/architecture.md
c release/0.2.0 jonah "Fix the tag picker's focus ring in Safari" web/components/TagPicker.tsx
changelog release/0.2.0 0.2.0 "Tags, with a picker on every bookmark." "Full-text search over titles and notes." "Favicons for every saved link."
ship release/0.2.0 0.2.0

# 0.3.0: import, dark mode, page archives.
at "2026-06-01 09:00"
br feature/import develop
br feature/dark-mode develop
c feature/import sofia "Parse Netscape bookmark files" src/import/netscape.ts
c feature/dark-mode jonah "Add theme tokens" web/theme.css
c feature/import sofia "Turn bookmark folders into tags" src/import/netscape.ts src/import/folders.ts
c feature/dark-mode jonah "Follow the system color scheme" web/theme.css web/hooks/useColorScheme.ts
c develop elena "Add a pre-commit hook script" scripts/pre-commit.sh
c feature/import sofia "Add the import dialog" web/components/ImportDialog.tsx
br fix/title-entities develop
c fix/title-entities luca "Decode HTML entities in page titles" src/fetch/title.ts
br feature/archive develop
c feature/archive tomas "Store readable snapshots of saved pages" src/archive/snapshot.ts src/db/archive.sql
c feature/dark-mode priya "Add a theme switch to settings" web/components/Settings.tsx
c feature/archive tomas "Strip scripts and trackers from snapshots" src/archive/sanitize.ts
c fix/title-entities luca "Test titles with entities" tests/title.test.ts
m develop fix/title-entities maya
c feature/dark-mode jonah "Dim images in dark mode" web/theme.css
m develop feature/dark-mode maya
c feature/import luca "Report skipped entries after an import" src/import/report.ts web/components/ImportDialog.tsx
c feature/import sofia "Import Pocket CSV exports" src/import/pocket.ts
c develop elena "Speed up the test database setup" tests/setup.ts
c feature/archive kenji "Show the archived copy when the original is gone" web/components/ArchiveView.tsx
c feature/import sofia "Test the parser against sample exports" tests/import.test.ts testdata/bookmarks.html
m develop feature/import maya
c feature/archive tomas "Cap snapshots at 5 MB" src/archive/snapshot.ts
c feature/archive kenji "Retry snapshots that time out" src/archive/retry.ts
c develop elena "Describe the import format" docs/import.md
m develop feature/archive maya
done_with feature/import feature/dark-mode feature/archive fix/title-entities
br release/0.3.0 develop
bump release/0.3.0 0.3.0
c release/0.3.0 sofia "Handle bookmark files with Windows line endings" src/import/netscape.ts
changelog release/0.3.0 0.3.0 "Import bookmarks from any browser's export." "Dark mode." "Readable archives of saved pages."
ship release/0.3.0 0.3.0

# 0.4.0: share links and keyboard shortcuts.
at "2026-06-17 09:00"
br feature/sharing develop
br feature/shortcuts develop
c feature/sharing luca "Add public share links for collections" src/share/links.ts src/db/shares.sql
c feature/shortcuts jonah "Add a keyboard shortcut registry" web/shortcuts/registry.ts
c feature/sharing luca "Render shared collections without signing in" web/pages/SharedCollection.tsx src/share/routes.ts
c feature/shortcuts jonah "Move through the list with j and k" web/shortcuts/list.ts web/components/BookmarkList.tsx
c develop elena "Add a contributing guide" CONTRIBUTING.md
c feature/sharing sofia "Let owners expire share links" src/share/links.ts web/components/ShareDialog.tsx
c feature/sharing sofia "Copy share links with one click" web/components/ShareDialog.tsx
c feature/shortcuts priya "Show a shortcut cheat sheet on ?" web/components/ShortcutHelp.tsx
c feature/shortcuts jonah "Ignore shortcuts while typing in a field" web/shortcuts/registry.ts
c feature/shortcuts priya "Jump between pages with g h and g r" web/shortcuts/goto.ts
m develop feature/shortcuts maya
c feature/sharing luca "Add Open Graph tags to shared pages" src/share/meta.ts
br fix/duplicate-urls develop
c fix/duplicate-urls tomas "Normalize URLs before checking for duplicates" src/routes/bookmarks.ts src/fetch/normalize.ts
c feature/sharing luca "Test share link expiry" tests/share.test.ts
c fix/duplicate-urls tomas "Merge tags when a duplicate is saved" src/routes/bookmarks.ts tests/bookmarks.test.ts
m develop fix/duplicate-urls maya
m develop feature/sharing maya
done_with feature/sharing feature/shortcuts fix/duplicate-urls
br release/0.4.0 develop
bump release/0.4.0 0.4.0
c release/0.4.0 luca "Fix share links in private windows" src/share/routes.ts
c release/0.4.0 luca "Escape collection names in page titles" src/share/meta.ts
changelog release/0.4.0 0.4.0 "Share a collection with a public link." "Keyboard shortcuts, with a cheat sheet on ?."
ship release/0.4.0 0.4.0

# 1.0.0: accounts, API tokens and the browser extension.
at "2026-07-01 09:00"
br feature/accounts develop
c feature/accounts maya "Add users and password hashing" src/auth/users.ts src/db/users.sql
br feature/extension develop
c feature/extension kenji "Scaffold the browser extension" extension/background.ts extension/popup.html
c feature/accounts maya "Add sign-in and sign-out routes" src/auth/routes.ts src/server.ts
c feature/extension kenji "Save the current tab from the toolbar button" extension/background.ts
c feature/accounts priya "Add the sign-in page" web/pages/SignIn.tsx
c develop elena "Read configuration from environment variables" src/config.ts .env.example
c feature/accounts maya "Scope bookmarks to their owner" src/routes/bookmarks.ts src/db/schema.sql
br feature/api-tokens develop
c feature/extension kenji "Pick tags in the popup before saving" extension/popup.html extension/popup.ts
c feature/api-tokens luca "Add personal API tokens" src/auth/tokens.ts src/db/tokens.sql
c feature/accounts tomas "Rate-limit failed sign-ins" src/auth/ratelimit.ts
br feature/export develop
c feature/export priya "Export bookmarks as HTML" src/export/html.ts
c feature/accounts maya "Reset passwords by email" src/auth/reset.ts web/pages/ResetPassword.tsx
c feature/export priya "Export bookmarks as JSON" src/export/json.ts
c feature/api-tokens luca "Hash tokens at rest" src/auth/tokens.ts
c feature/accounts tomas "Expire sessions after 30 days" src/auth/sessions.ts
c feature/api-tokens luca "Accept tokens in the Authorization header" src/auth/middleware.ts
m develop feature/accounts maya
c feature/extension sofia "Send the API token with each save" extension/background.ts
c feature/api-tokens luca "List and revoke tokens in settings" web/components/TokenList.tsx
c feature/export jonah "Add export buttons to settings" web/components/ExportPanel.tsx
c feature/extension kenji "Show a badge when the page is already saved" extension/background.ts
br fix/csrf develop
c fix/csrf tomas "Check the Origin header on form posts" src/auth/csrf.ts
c develop elena "Add a seed script for local data" scripts/seed.ts
c fix/csrf tomas "Test cross-site form posts" tests/csrf.test.ts
m develop fix/csrf maya
m develop feature/export maya
m develop feature/api-tokens maya
c feature/extension kenji "Package the extension for Firefox and Chromium" extension/build.sh
c develop elena "Write the upgrade guide for 1.0" docs/upgrading.md
m develop feature/extension maya
done_with feature/accounts feature/api-tokens feature/extension feature/export fix/csrf
br release/1.0.0 develop
bump release/1.0.0 1.0.0
c release/1.0.0 tomas "Set SameSite=Lax on the session cookie" src/auth/routes.ts
c release/1.0.0 priya "Fit the sign-in page on small screens" web/pages/SignIn.tsx
changelog release/1.0.0 1.0.0 "Accounts: every bookmark belongs to someone." "Personal API tokens." "A browser extension for Firefox and Chromium."
ship release/1.0.0 1.0.0

# 1.1.0: the reading list and tag suggestions; then the 1.1.1 hotfix.
at "2026-07-27 09:00"
br feature/reading-list develop
br feature/tag-suggestions develop
c feature/reading-list priya "Add a read-later flag to bookmarks" src/db/schema.sql src/routes/bookmarks.ts
c feature/tag-suggestions tomas "Suggest tags from the page's keywords" src/tags/suggest.ts
c feature/reading-list priya "Add the reading list view" web/pages/ReadingList.tsx
c feature/tag-suggestions tomas "Learn from tags picked before" src/tags/suggest.ts src/tags/history.ts
br feature/notes develop
c feature/notes luca "Add notes to bookmarks" src/notes/model.ts src/db/notes.sql
c develop jonah "Switch to React 19's root API" web/main.tsx
c feature/reading-list sofia "Mark items read when they're opened" web/pages/ReadingList.tsx src/routes/reading.ts
c feature/tag-suggestions jonah "Show suggestions in the TagPicker" web/components/TagPicker.tsx
c feature/notes luca "Render notes as Markdown" web/components/NoteEditor.tsx
c feature/tag-suggestions tomas "Skip stop words in suggestions" src/tags/stopwords.ts
br fix/search-accents develop
c fix/search-accents kenji "Fold accents when indexing and searching" src/search/tokenize.ts tests/search.test.ts
m develop fix/search-accents maya
c feature/reading-list priya "Estimate reading time" src/archive/readingTime.ts
c feature/reading-list priya "Sort the reading list by reading time" web/pages/ReadingList.tsx
c feature/notes sofia "Search inside notes" src/search/index.ts
br fix/session-refresh develop
c fix/session-refresh maya "Refresh the session before it expires" src/auth/sessions.ts
m develop feature/reading-list maya
c feature/tag-suggestions tomas "Test suggestion ranking" tests/suggest.test.ts
c feature/notes luca "Test note rendering" tests/notes.test.ts
c fix/session-refresh maya "Test session refresh" tests/sessions.test.ts
m develop fix/session-refresh maya
c develop elena "Document the extension's permissions" docs/extension.md
m develop feature/notes maya
m develop feature/tag-suggestions maya
done_with feature/reading-list feature/tag-suggestions fix/search-accents feature/notes fix/session-refresh
br release/1.1.0 develop
bump release/1.1.0 1.1.0
c release/1.1.0 jonah "Keep the reading list's scroll position" web/pages/ReadingList.tsx
changelog release/1.1.0 1.1.0 "A reading list, with reading times." "Tag suggestions from the page and your history." "Accent-insensitive search."
ship release/1.1.0 1.1.0
br hotfix/1.1.1 main
c develop elena "Add a FAQ to the docs" docs/faq.md
c hotfix/1.1.1 luca "Reject revoked API tokens" src/auth/middleware.ts tests/tokens.test.ts
bump hotfix/1.1.1 1.1.1
changelog hotfix/1.1.1 1.1.1 "Fix: revoked API tokens were still accepted."
ship hotfix/1.1.1 1.1.1

# 1.2.0: bulk actions; then the work still in progress.
at "2026-08-24 09:00"
br feature/bulk-actions develop
br feature/reader-mode develop
c feature/bulk-actions sofia "Select several bookmarks with shift-click" web/components/BookmarkList.tsx web/hooks/useSelection.ts
c feature/reader-mode kenji "Render archived pages in a reader view" web/pages/Reader.tsx
c feature/bulk-actions sofia "Tag, archive or delete a selection at once" web/components/BulkBar.tsx src/routes/bulk.ts
c develop elena "Explain backups and restores" docs/backups.md
c feature/reader-mode kenji "Add font size and line width controls" web/pages/Reader.tsx web/components/ReaderControls.tsx
c feature/bulk-actions luca "Undo the last bulk action" src/routes/bulk.ts web/components/BulkBar.tsx
c feature/bulk-actions sofia "Confirm before deleting more than ten bookmarks" web/components/BulkBar.tsx
c feature/bulk-actions sofia "Test the bulk routes" tests/bulk.test.ts
m develop feature/bulk-actions maya
done_with feature/bulk-actions
br feature/saved-searches develop
c feature/saved-searches priya "Save a search as a smart collection" src/search/saved.ts
br release/1.2.0 develop
bump release/1.2.0 1.2.0
br feature/offline-sync develop
c feature/offline-sync maya "Cache the app shell in a service worker" web/sw.ts web/main.tsx
c release/1.2.0 priya "Keep the bulk bar off the last row" web/components/BulkBar.tsx
c feature/reader-mode kenji "Remember reader settings per device" web/components/ReaderControls.tsx
c feature/offline-sync maya "Keep bookmarks in IndexedDB for offline reading" web/offline/store.ts
c feature/saved-searches priya "List saved searches in the sidebar" web/components/SavedSearches.tsx
changelog release/1.2.0 1.2.0 "Bulk actions: tag, archive or delete many bookmarks at once, with undo."
ship release/1.2.0 1.2.0
br fix/import-encoding develop
c fix/import-encoding sofia "Detect the charset of imported bookmark files" src/import/netscape.ts src/import/charset.ts
c develop elena "Draft the sync protocol notes" docs/sync.md
c feature/saved-searches kenji "Keep saved searches current as bookmarks change" src/search/saved.ts tests/saved.test.ts
c develop tomas "Add a health check endpoint" src/routes/health.ts
c feature/offline-sync priya "Show a banner while offline" web/components/OfflineBanner.tsx
m feature/offline-sync develop maya
c fix/import-encoding sofia "Test Latin-1 and Shift JIS exports" tests/import.test.ts testdata/bookmarks-latin1.html
c feature/reader-mode kenji "Hyphenate long words in narrow columns" web/pages/Reader.css

# The commit the screenshot selects: real code in a few files, a body and a co-author.
sw feature/offline-sync
mkdir -p web/offline web/hooks tests/offline
cat > web/offline/queue.ts <<'EOF'
import { openStore } from './store';

/** An edit made while offline, replayed in order once the server is reachable again. */
export interface PendingEdit {
  id: string;
  bookmarkId: string;
  patch: Record<string, unknown>;
  madeAt: number;
}

const QUEUE = 'pending-edits';

export async function enqueue(edit: PendingEdit): Promise<void> {
  const store = await openStore();
  await store.put(QUEUE, edit, edit.id);
}

export async function pending(): Promise<PendingEdit[]> {
  const store = await openStore();
  const edits = await store.getAll<PendingEdit>(QUEUE);
  return edits.sort((a, b) => a.madeAt - b.madeAt);
}

export async function forget(id: string): Promise<void> {
  const store = await openStore();
  await store.delete(QUEUE, id);
}
EOF
cat > web/offline/replay.ts <<'EOF'
import { api } from '../api';
import { forget, pending } from './queue';

/** Sends queued edits oldest first; stops at the first failure and keeps the rest queued. */
export async function replay(): Promise<number> {
  let sent = 0;
  for (const edit of await pending()) {
    const res = await api.patch(`/bookmarks/${edit.bookmarkId}`, edit.patch);
    if (!res.ok && res.status !== 404) break;
    await forget(edit.id);
    sent++;
  }
  return sent;
}
EOF
cat > web/hooks/useOnline.ts <<'EOF'
import { useEffect, useState } from 'react';
import { replay } from '../offline/replay';

export function useOnline(): boolean {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const up = () => { setOnline(true); void replay(); };
    const down = () => setOnline(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return online;
}
EOF
cat > tests/offline/queue.test.ts <<'EOF'
import { describe, expect, it } from 'vitest';
import { enqueue, pending } from '../../web/offline/queue';

describe('the offline queue', () => {
  it('returns edits oldest first', async () => {
    await enqueue({ id: 'b', bookmarkId: '1', patch: { read: true }, madeAt: 2 });
    await enqueue({ id: 'a', bookmarkId: '1', patch: { tags: ['later'] }, madeAt: 1 });
    expect((await pending()).map((e) => e.id)).toEqual(['a', 'b']);
  });
});
EOF
printf "\nexport const STORES = ['bookmarks', 'pending-edits'] as const;\n" >> web/offline/store.ts
git add -A
tick
as maya commit -q -F - <<EOF
Queue edits while offline and replay them on reconnect

Edits made offline now wait in an IndexedDB queue and go out oldest first once the browser is back online. A failed request keeps the rest queued.

Co-authored-by: ${NAME[priya]} <${EMAIL[priya]}>
EOF

# The remote: everything so far is pushed, the merged branches long gone.
git init -q --bare -b main "$dir/.remotes/driftwood.git"
git remote add origin "$dir/.remotes/driftwood.git"
git push -q -u origin main develop feature/offline-sync feature/reader-mode feature/saved-searches
git push -q origin --tags

# A colleague pushes to feature/reader-mode (so the local branch is behind), while offline-sync
# gets commits that aren't pushed yet (ahead).
git clone -q -b feature/reader-mode "$dir/.remotes/driftwood.git" "$dir/.remotes/colleague"
pushd "$dir/.remotes/colleague" > /dev/null
c feature/reader-mode kenji "Add keyboard shortcuts to the reader" web/pages/Reader.tsx web/shortcuts/reader.ts
popd > /dev/null
c feature/offline-sync priya "Resolve conflicting edits by last write" web/offline/replay.ts tests/offline/replay.test.ts
pushd "$dir/.remotes/colleague" > /dev/null
c feature/reader-mode jonah "Lay out right-to-left pages correctly" web/pages/Reader.css
git push -q origin feature/reader-mode
popd > /dev/null
rm -rf "$dir/.remotes/colleague"
c feature/offline-sync maya "Sync the reading list in the background" web/sw.ts
git fetch -q origin

# A stash and uncommitted work on the checked-out branch.
sw feature/offline-sync
edit web/components/BookmarkList.tsx "Render only the visible rows"
tick
as maya stash push -q -m "Try a virtualized bookmark list"
edit web/offline/replay.ts "Back off after repeated failures"
edit web/sw.ts "Skip the cache for API requests"
git add web/sw.ts
printf 'export const BACKOFF_MS = [1_000, 5_000, 30_000];\n' > web/offline/backoff.ts

# --- the other tabs: small repos -----------------------------------------------------------------

clock=0
at "2026-07-06 10:00"
new_repo "$dir/docs-site"
printf '# Driftwood docs\n\nThe user guide, built with a static site generator.\n' > README.md
git add -A; tick; as elena commit -q -m "Initial commit"
c main elena "Add the getting started guide" content/getting-started.md
c main elena "Add the import guide" content/import.md
c main priya "Add a dark theme" theme/site.css
c main elena "Document API tokens" content/api-tokens.md
br search main
c search kenji "Add client-side search" theme/search.js
c main elena "Fix broken links in the FAQ" content/faq.md
c search kenji "Index headings as well as titles" theme/search.js
m main search elena
git branch -q -d search
c main elena "Document the reading list" content/reading-list.md

clock=0
at "2026-06-10 10:00"
new_repo "$dir/infra"
printf '# infra\n\nDeployment for the Driftwood demo instance.\n' > README.md
git add -A; tick; as tomas commit -q -m "Initial commit"
c main tomas "Add the container host" terraform/main.tf
c main tomas "Back up the database nightly" terraform/backup.tf scripts/backup.sh
c main luca "Add a staging environment" terraform/staging.tf
c main luca "Renew certificates automatically" scripts/renew-certs.sh
c main tomas "Alert when the disk is 80% full" terraform/monitoring.tf

clock=0
at "2026-08-03 10:00"
new_repo "$dir/mobile-app"
printf '# Driftwood mobile\n\nA small companion app for the reading list.\n' > README.md
git add -A; tick; as jonah commit -q -m "Initial commit"
c main jonah "Sign in with an API token" src/auth.ts src/screens/SignIn.tsx
c main jonah "List the reading list" src/screens/ReadingList.tsx
br share-sheet main
c share-sheet sofia "Save links from the share sheet" src/share.ts
c main jonah "Pull to refresh" src/screens/ReadingList.tsx
c share-sheet sofia "Pick tags before saving" src/screens/TagSheet.tsx
c main priya "Open articles in the reader" src/screens/Reader.tsx
c share-sheet sofia "Confirm with a toast" src/share.ts

echo "showcase ready in $dir: driftwood ($(git -C "$dir/driftwood" rev-list --all --count) commits), docs-site, infra, mobile-app"
