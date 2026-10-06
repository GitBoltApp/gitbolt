# Architecture

This is a map of how GitBolt is put together, for anyone about to change it. It describes what
the code does today; when the two disagree, the code wins, and this file should be fixed.

GitBolt is a Linux desktop app: a Rust backend that does all the git work, a React UI that draws
it, and Tauri 3 on its Chromium (CEF) runtime holding the two together.

```
┌──────────────────────── gitbolt (one process tree) ────────────────────────┐
│                                                                            │
│  ui/  React 19 + TypeScript, in Chromium (CEF)                             │
│    invoke('api', {req})  ──►              ◄── 'gb:event' (AppEvent)        │
│  ──────────────────────────────────────────────────────────────────────    │
│  gitbolt-app   Tauri 3 shell: window, CEF runtime, wiring                  │
│  gitbolt-core  Api::dispatch(Request) · event bus · reads · write pipeline │
│                watcher · graph layout · settings · journal · askpass       │
│  gitbolt-forge GitHub / GitLab providers · HTTP client · token store       │
│                                                                            │
└──────┬───────────────────────┬─────────────────────────┬───────────────────┘
       │ gix (in-process)      │ git CLI (child process) │ HTTPS
       ▼                       ▼                         ▼
   .git objects/refs     hooks, config, credentials   GitHub / GitLab APIs
```

## Crates and the UI

The Cargo workspace has four crates under `crates/`; the UI is a separate npm project in `ui/`.

**`gitbolt-core`** owns everything a git client does, with no Tauri dependency. Its entry point is
`Api` (`src/api.rs`): one `Request` enum of every method the UI can call, and one `dispatch`
function that answers it. Around that: repository reads (`walk.rs`, `snapshot.rs`, `details.rs`,
`diff.rs`, `history.rs`, …), the graph layout (`graph/`), the write pipeline (`write/`) and its
undo journal (`journal/`), the file watcher (`watch.rs`), the event bus (`events.rs`), settings and
profiles (`settings.rs`), askpass (`askpass.rs`), log files (`logging.rs`), and the forge layer's
contract (`forge/`: the normalized types the UI sees, the `ForgeProvider` trait, the hub that holds
accounts, the cache). Core never speaks HTTP; it defines traits that the other crates implement.

**`gitbolt-forge`** implements that contract for real forges: `github.rs` (GitHub REST),
`gitlab.rs` (GitLab REST v4), one HTTP client per account (`http.rs`), the token store
(`tokens.rs`), avatar and Markdown-image fetching, and Gravatar (`gravatar.rs`). It depends on core,
never the other way round.

**`gitbolt-app`** is the desktop binary (`gitbolt`). `src/main.rs` builds the `Api` with the real
implementations (system openers, the folder-picker portal, Gravatar, the forge connector and the
keyring token store), starts the CEF runtime with a required sandbox, registers a single Tauri
command, forwards the event bus to the webview, and handles startup and shutdown (askpass mode,
the single-instance guard, letting a running write finish before exit). `desktop.rs` sets the
window's desktop identity and the environment children get back; `window_state.rs` restores the
window's size and position.

**`gitbolt-harness`** serves the same `Api` over a WebSocket so the UI can run in a plain browser
with no Tauri, and adds a fake GitHub/GitLab, fixture repositories and test-only routes. It's what
the Playwright suite drives; see [Testing](#testing).

**`ui/`** is React 19, TypeScript and Vite, with zustand for state. It's organized by feature
(`graph/`, `diff/`, `stage/`, `forge/`, `markdown/`, `settings/`, …). Each feature module
registers its actions, menus and UI slots at import time (`ui/src/app/features.ts` lists them), so
the command palette, menus and shortcuts all draw from one registry, and features don't edit each
other's files. Per-tab view state (selection, open diff, caches) lives in a store per tab
(`app/tabStores.ts`). Monaco, Shiki and Mermaid load lazily; `ui/scripts/check-entry-chunk.mjs`
fails the build if Monaco or Shiki reach the startup bundle.

`vendor/tauri-runtime-cef/` is a patched copy of Tauri's CEF runtime; `GITBOLT-PATCH.md` there says
what changed and why. Why CEF and not WebKitGTK is in
[docs/decisions/cef-over-webkitgtk.md](docs/decisions/cef-over-webkitgtk.md).

## The process model

GitBolt runs as one Chromium process tree. CEF starts its renderer, GPU and utility helpers by
re-running the same `gitbolt` binary with a `--type=` argument; the entry point sends those off to
CEF before any app code runs. On Linux the runtime uses `SandboxPolicy::Required`: without a usable
sandbox the app refuses to start rather than run Chromium unsandboxed (see
[docs/dev-setup.md](docs/dev-setup.md) for the setuid helper a dev build needs).

Before any window, `main` also checks two other ways the binary can be started:
- **As askpass.** Git and ssh run `gitbolt` itself as their credential prompt (see
  [Askpass](#askpass)). In that mode it asks the running app and exits.
- **As a second launch.** One GitBolt runs per config directory, guarded by a lock and a socket
  (`$XDG_RUNTIME_DIR/gitbolt-instance-<hash of the config dir>.{lock,sock}`). A second launch on
  the same config dir hands its path (argv or `GITBOLT_OPEN`) to the running one, which opens it in
  a tab and comes to the front, and exits 0. `GITBOLT_MULTI_INSTANCE=1` skips the guard (both
  instances then write the same settings files; the last write wins).

### The request API

The UI and the backend talk through one Tauri command, `api`, which takes a `Request` and returns
JSON or a `GbError`. `Request` is a serde enum tagged as `{"method": "...", "params": {...}}`, so
adding a method means adding a variant and a match arm in `Api::dispatch`. The UI's side is
`ui/src/api/transport.ts` (Tauri `invoke` in the app, a WebSocket to the harness elsewhere) and
`ui/src/api/client.ts` (typed wrappers).

The TypeScript types for every request, payload and event are generated from the Rust types with
ts-rs into `ui/src/api/gen/`, which is committed. After
changing a type that crosses the boundary, run `just gen-types` and commit the result.

### The event bus

The backend pushes changes to the UI through one broadcast channel (`EventBus`, `events.rs`):
`repoChanged` (which parts of which worktrees changed), `refsUpdated`, an operation's
`opStarted` / `opProgress` / `opOutput` / `opFinished`, `journalChanged`, `queueChanged`,
`authWaiting` / `authResolved` for credential prompts, and `openRequested` from a second launch.
The app emits each one as the Tauri event `gb:event`; the harness sends it on every WebSocket as an
`{"event": …}` frame. The UI subscribes once and fans events out to its stores.

## Reads and writes

### Reads

Most reads go through [gitoxide](https://github.com/GitoxideLabs/gitoxide) (`gix`) in-process:
refs, the commit walk for the graph, commit details, trees and blobs. Some reads still run the git
CLI, where git's own output is the reference: `git status --porcelain=v2`, changed-file lists
(`diff-tree` / `diff --raw --numstat`), the hunks used for staging, blame, file history
(`log --follow`), signature verification and commit search.

Every git CLI run goes through one runner, `GitCli` (`git.rs`). It requires git 2.40 or newer,
applies timeouts and cancellation, redacts secrets from what it records, and keeps the last 1000
commands for Help → Debug. Git runs with the user's login-shell environment (captured once at
startup, so `SSH_AUTH_SOCK` and `PATH` additions apply even when GitBolt starts from a desktop
launcher). A profile's extra gitconfig is passed as `-c include.path=…`.

### Writes

Every write runs the git CLI, never gix, and every write goes through one function, `run_write`
(`write/mod.rs`). A write is a `WriteIntent`; only the write module can mint the `WriteToken` that
`GitInvocation::write` requires, so a read path can't build a write by accident. An API test
(`WRITE_METHODS` in `api.rs`) checks that every method either is a declared write or never writes.

Why the CLI: GitBolt should behave exactly as `git` does in a terminal. Hooks (pre-commit,
commit-msg, pre-push, …) run, every kind of config applies (includes, conditional includes,
per-repo settings), commit signing works however it's configured, and credential helpers and ssh
agents are used as usual.

`run_write`'s steps, in order:

1. **Queue and lock.** Each repository has one write lock and one action queue, shared by all its
   tabs and worktrees (`write/queue.rs`). User operations run one at a time, in click order; a
   failure stops the items queued behind it until Resume or Clear. Quick writes (stage, discard)
   skip the queue and take the lock directly. A background fetch runs only when the queue is
   idle, and queuing a user operation cancels it.
2. **Preflight**: read-only checks: HEAD and the refs are still what the UI showed (`Expect`),
   which paths the operation touches and which of them are dirty, and whether restoring an
   autostash would conflict.
3. **Journal write-ahead**: the entry is recorded before anything changes.
4. **Snapshot** of the paths the operation may destroy (see below).
5. **Autostash**, only when the operation needs a clean tree and the dirty files overlap it.
6. **Run** the git command(s).
7. **Verify** the result, then **restore** the autostash.
8. **Finalize** the journal entry.
9. **Announce**: `repoChanged` (and `refsUpdated` if a ref moved) to every tab of the repository,
   whatever the outcome.

### Undo and redo

The journal (`journal/`) records GitBolt's own operations, one file per worktree in the data dir
(`<data>/journal/<hash>.json`, mode 0600), never inside `.git`. It keeps the last 50 operations. An
entry holds the ref moves (applied back with compare-and-swap, so a change made outside GitBolt
isn't overwritten) and, where files were at risk, a snapshot: stash-shaped commits of the index,
the worktree and the untracked files involved, built through a temporary index so the real one is
never touched. No ref points at them, so git's default prune expiry (two weeks) keeps them, and
the journal lets them go after the same 14 days. Undo and redo are writes themselves. Redo replays the
recorded result; it never re-runs the original command, so hooks and signing don't run twice.

Staging has its own, separate undo stack (`journal/staging.rs`): the last 100 stage/unstage steps
per worktree, in memory only.

Forge actions (replying, approving, merging an MR/PR, …) are remote calls, not git writes, and aren't
journaled.

### Askpass

Git and ssh never prompt on a terminal. Network commands run with `GIT_TERMINAL_PROMPT=0`, stdin
closed, and in their own session with no controlling terminal. `GIT_ASKPASS` and `SSH_ASKPASS`
point at the `gitbolt` binary itself (`SSH_ASKPASS_REQUIRE=force`, so ssh uses it with or without
`DISPLAY`; OpenSSH 8.4+).

When git runs it, the binary connects to the app's per-session Unix socket
(`$XDG_RUNTIME_DIR/gitbolt-askpass-<pid>-<rand>.sock`, mode 0600, removed on exit), sends the
prompt with the session's random token, and prints the answer. The app checks the peer's user
(`SO_PEERCRED`) and the token, and shows a modal only for an operation the user started. A
background fetch that needs credentials is denied at once and reported as skipped in the status
bar. `docs/dev-setup.md` has a walk-through for trying this without real keys.

## The graph

**Snapshot.** The `graph` request builds a `GraphPayload` (`snapshot.rs`): the refs, a commit walk
from every tip (newest first, with clock-skew inversions fixed so children always come before
parents; `walk.rs`), the stashes, WIP rows from `git status`, and the lane layout.
It loads up to the commit limit (2000 by default, a setting).

**Walk cache.** Each open repository keeps its last walk, keyed by the tips, the limit and the
stash set. Commits are immutable, so when those match, a rebuild (switching the active worktree, a
status-only change) lays out again without walking.

**Lane layout** (`graph/layout.rs`) is one top-to-bottom pass whose only state is the lane vector,
so a window can be laid out in chunks and a shorter window lays out as the prefix of a longer one.
A commit lands in the lane of the first child that reached it; a tip takes the left-most free
lane; the parents of a merge are locked to their lanes, so a trunk of merges stays straight. The
layout emits per-row segments that the UI only has to draw.

**Pinned trunk.** One branch can be pinned to lane 0. By default it's the local counterpart of the
main remote's default branch: the remote's HEAD (or main, master, dev, develop), with remotes
ordered so a fork's parent comes first (from the forge's cached data, then `upstream` before
`origin`), then the local branch tracking it. Each repository can pick another ref or turn it off.

**Drawing.** The rows are DOM elements in a list virtualized with `@tanstack/react-virtual`; the
lines and nodes are drawn on one `<canvas>` beside them (`ui/src/graph/GraphCanvas.tsx`,
`draw.ts`). The canvas sits inside the scrolled content and covers a band taller than the
viewport, so the compositor scrolls it together with the rows. It's redrawn only when the viewport
gets close to the band's edge, so a fast scroll never shows the graph out of step with its rows.

## Watching and refreshing

Only the active tab is watched (`watch.rs`, inotify through the `notify` crate). Instead of one
recursive watch per worktree, which ignored trees like `node_modules` would exhaust, it watches
every tracked directory (from the index) and every directory holding an untracked, non-ignored
file, non-recursively, plus `.git`, `.git/worktrees`, each linked worktree's gitdir, and
`.git/refs` recursively. Events are classified (worktree, index, refs, HEAD, stash, config,
merge/rebase state), debounced (150 ms, at most 1 s while events keep coming), and a worktree change
is confirmed against a digest of `git status`, so churn in ignored files and GitBolt's own reads
never reach the UI. Past 20 000 directories, or at inotify's own limit, the watch is degraded: it
still reports what it sees, but every graph build re-reads status. During a write, the watcher is
held and the write announces its own changes.

Inactive tabs aren't watched, and aren't even opened until first activated. Activating a tab
re-reads status for every worktree.

**Background fetch.** The UI's scheduler (`ui/src/app/fetchSchedule.ts`) fetches the active tab's
repository every `fetchIntervalSecs` (60 by default; 0 turns it off). Ticks are skipped while the
window is minimized and caught up on focus. The fetch is `git fetch --all` with `--prune` or
`--no-prune` per the Prune setting, `--no-prune-tags` and `--no-write-fetch-head`, so it changes
only remote-tracking refs and objects. Like a plain `git fetch`, it then lets git run its auto
maintenance. A successful background fetch shows only in the activity log.

## Diffs

**Text** diffs use Monaco's diff editor (`ui/src/diff/monaco/host.ts`): inline or side by side,
with GitBolt's own hunk and line staging actions. Syntax highlighting is Shiki's TextMate grammars
bridged into Monaco (`diff/monaco/shiki.ts`, `@shikijs/monaco`), with the Oniguruma WASM loaded on
the first diff. The core supplies changed-file lists and both sides' contents; the UI never
re-derives which blobs to compare.

**Images** (`ui/src/image/`) compare side by side, with a swipe, as onion skin, or as a pixel
difference, with zoom. **Binary** files show in a hex view: the core makes capped hex dumps
(`hex.rs`) and two read-only Monaco panes show hex and text, scrolled together, changed bytes
marked.

**Rendered Markdown** (`ui/src/markdown/`) is used for `.md` files, their diffs, and MR/PR text:
1. **Parse**: unified with `remark-parse` and `remark-gfm`, plus GitBolt's plugins for emoji,
   issue/MR references, heading ids and an autolink guard (`parse.ts`). Up to 16 KiB parses on the main
   thread in an idle callback; longer texts parse in a Web Worker (`parse.worker.ts`) and arrive in
   chunks that render progressively.
2. **Sanitize**: `remark-rehype`, `rehype-raw` (inline HTML becomes real nodes), then
   `rehype-sanitize` with GitHub's schema, tightened (`sanitize.ts`): no `style` or form
   attributes, ids prefixed `user-content-`, links limited to http(s), mailto and relative, and
   `data:` images limited to raster formats.
3. **Render** to React with `hast-util-to-jsx-runtime`, with GitBolt components for code blocks
   (Shiki), links, images and Mermaid diagrams.
4. **Diff** (`markdown/diff/`): the old and new trees are aligned block by block (paragraphs,
   headings, list items, table rows), similar blocks are paired and word-diffed with `jsdiff`, and
   the result renders inline or side by side. Very long blocks aren't word-diffed, and an
   alignment that takes too long falls back to the source diff.

Remote images in Markdown are fetched by the core, not the webview: a forge's own image hosts
through that account's provider, any other host only when the user chooses to load it.

## Forge layer

GitHub and GitLab are the two providers (`gitbolt-forge`), both over personal access tokens. Core
holds the `ForgeHub` (`forge/hub.rs`): the active profile's accounts, a provider per account built
on first use, and each account's last known status. It maps each remote to its forge project and
answers the MR/PR badges, the sidebar list, the MR/PR view, the Create MR/PR flow and stacked
MRs/PRs (`forge/mrs.rs`, `forge/create.rs`, `forge/stack.rs`).

**HTTP** (`gitbolt-forge/src/http.rs`): one client per account with bearer auth, an ETag cache
(`If-None-Match`, so an unchanged answer is a cheap 304), the forges' poll-interval hints, rate
limits (once limited, requests fail fast until the reset time), timeouts, and
`User-Agent: GitBolt/<version>`.

**Tokens** (`gitbolt-forge/src/tokens.rs`) live in the system Secret Service through the `keyring`
crate (service `gitbolt`, account `<profile id>/<host>`). Where there's no Secret Service, they go
to `~/.local/share/gitbolt/forge-tokens` (file 0600, directory 0700), and Settings › Accounts warns
about it. Tokens never go in settings files, and nothing logs, prints or formats one.

**Cache** (`forge/cache.rs`): per project, the last MR/PR lists and badge lookups with their ETags,
in `<data dir>/forge-cache/`. A relaunch shows the last list at once, and its first poll
revalidates instead of downloading everything again. It holds the forge's own data, never a token.

**Polling** (`ui/src/forge/poller.ts`): only the active tab polls, when it becomes active, on the
fetch timer (at most once a minute, and only while the window has the focus), when the window gets
the focus back, and after a GitBolt forge action. While a visible MR/PR's pipeline runs, it polls
faster (20 s, backing off to 2 min). A failed poll keeps the data shown.

## Settings, profiles and logs

| What | Where |
|---|---|
| App settings (fetch interval, prune, commit limit, date format, Gravatar, window geometry, …) | `$XDG_CONFIG_HOME/gitbolt/settings.json` |
| Profiles (tabs, recent repos, repos folder, editor, extra gitconfig, host overrides, per-repo settings) | `$XDG_CONFIG_HOME/gitbolt/profiles/<id>/profile.json` |
| Undo journal | `$XDG_DATA_HOME/gitbolt/journal/` |
| Forge cache | `$XDG_DATA_HOME/gitbolt/forge-cache/` |
| Forge tokens (only without a Secret Service) | `$XDG_DATA_HOME/gitbolt/forge-tokens` |
| Log files | `$XDG_CACHE_HOME/gitbolt/logs/gitbolt.YYYY-MM-DD.log` |
| Avatars, forge avatars, "open old version" copies | `$XDG_CACHE_HOME/gitbolt/{avatars,forge-avatars,open}/` |
| Chromium profile | `$XDG_CACHE_HOME/dev.gitbolt.desktop/cef/` |

The XDG defaults are `~/.config`, `~/.local/share` and `~/.cache`. Settings and profiles are
written debounced and flushed once more on exit. To run a second instance without touching your
own, point `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_DATA_HOME` at throwaway directories.

**Logs** rotate daily; 7 files and 50 MB at most are kept. The level is `info`; Settings › Advanced ›
Debug logging switches to `debug` live, and `RUST_LOG` applies until it does. A release build writes
to the console only when `RUST_LOG` is set. Help → Debug… opens the Debug modal: the last 1000 git
commands, the actions you ran, the activity log of fetches and clones, **Copy diagnostics**
(versions, OS, Chromium, git and the settings, with secrets removed) and **Open logs folder**.

**Folder picker.** Open folder… calls xdg-desktop-portal's `FileChooser` over D-Bus
(`crates/gitbolt-core/src/openers/folder_picker.rs`), parented to the main window, rather than a
GTK 3 dialog that would clash with CEF's GTK 4. Without a portal, it picks nothing and logs a
warning.

## Testing

Tests live in three layers. Use the cheapest one that proves the behavior.

- **Rust** (`cargo nextest run --workspace`, or `just test-rust`): unit tests next to the code, on
  throwaway repositories from `gitbolt_core::testing` (`TestRepo`, deterministic fixtures with
  fixed dates and an environment isolated from your git config and ssh agent). The
  harness's integration tests are one test binary, `crates/gitbolt-harness/tests/it/`, one module
  per area: `cargo nextest run -p gitbolt-harness -E 'test(/^forge_stacks::/)'`.
- **UI unit tests** (vitest with jsdom, `just test-ui`): components and logic, next to the source
  as `*.test.ts(x)`.
- **End to end** (Playwright, `just e2e`, `ui/e2e/`): the real UI against the real backend
  through the harness.

`testdata/` holds JSON test vectors that both the Rust and the TypeScript tests check, so the two
sides of a shared rule can't drift.

**The harness.** `gitbolt-harness serve [--port N] [--config-dir DIR]` serves `Api::dispatch`
over a WebSocket (`/ws`: `{id, req}` in, `{id, ok|err}` and `{event}` out), so the UI runs in an
ordinary browser. It uses a throwaway config dir (never `~/.config/gitbolt`), a temp home and
runtime dir, an isolated git environment and no avatar provider. It starts with background fetch
off, records "Open in…" launches instead of running them, and refuses writes to any repository
that isn't a marked fixture. Test-only routes: `POST /test/reset`, `/test/emit`, `/test/next-pick`,
`/test/write`, `GET /test/watched`, `GET /launches`, `ANY /test/auth/*` (always 401), and the fake
forge's `/test/forge/{seed,script,requests,account}`. `gitbolt-harness fixture <name> <dir>` builds
a fixture repository.

**The fake forge** (`crates/gitbolt-harness/src/fake_forge/`) answers the subset of the GitHub and
GitLab REST APIs that the providers use, from a seed: ETags with 304s, each forge's rate-limit
headers, scripted one-shot answers (429s, 500s, poll intervals), and a request log that records
whether a valid token came but never the token. It runs on its own ephemeral port. The harness's
connector points the real providers at it and can reach no other host, and its tokens go in a file
in the temp dir, never the system keyring.

**Fixtures** are built once per e2e run with `gitbolt-harness fixture` and copied for each test
that needs a fresh one (`freshFixture` in `ui/e2e/fixtures.ts`).

**Playwright** runs on one worker against a production build of the UI (`vite build --mode e2e`,
rebuilt only when its inputs change), with three projects: `chromium` (what CEF embeds, the main
target), `chromium-budget` (tests tagged `@budget` that assert latency budgets, run last), and
`webkit` for engine portability. `docs/dev-setup.md` covers the options: running one spec, traces,
the dev server, and ports for running from several worktrees at once.
