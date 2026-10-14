# Architecture

This is a map of how GitVolt is put together, for anyone about to change it. It describes what
the code does today; when the two disagree, the code wins, and this file should be fixed.

GitVolt is a desktop app for Linux and Windows: a Rust backend that does all the git work, a
React UI that draws it, and Tauri 3 on its Chromium (CEF) runtime holding the two together.

```
┌──────────────────────── gitvolt (one process tree) ────────────────────────┐
│                                                                            │
│  ui/  React 19 + TypeScript, in Chromium (CEF)                             │
│    invoke('api', {req})  ──►              ◄── 'gb:event' (AppEvent)        │
│  ──────────────────────────────────────────────────────────────────────    │
│  gitvolt-app   Tauri 3 shell: window, CEF runtime, wiring                  │
│  gitvolt-core  Api::dispatch(Request) · event bus · reads · write pipeline │
│                watcher · graph layout · settings · journal · askpass       │
│  gitvolt-forge GitHub / GitLab providers · HTTP client · token store       │
│                                                                            │
└──────┬───────────────────────┬─────────────────────────┬───────────────────┘
       │ gix (in-process)      │ git CLI (child process) │ HTTPS
       ▼                       ▼                         ▼
   .git objects/refs     hooks, config, credentials   GitHub / GitLab APIs
```

## Crates and the UI

The Cargo workspace has six crates under `crates/`; the UI is a separate npm project in `ui/`.

**`gitvolt-core`** owns everything a git client does, with no Tauri dependency. Its entry point is
`Api` (`src/api.rs`): one `Request` enum of every method the UI can call, and one `dispatch`
function that answers it. Around that: repository reads (`walk.rs`, `snapshot.rs`, `details.rs`,
`diff.rs`, `history.rs`, …), the graph layout (`graph/`), the write pipeline (`write/`) and its
undo journal (`journal/`), the file watcher (`watch.rs`), the event bus (`events.rs`), settings and
profiles (`settings.rs`), askpass (`askpass.rs`), log files (`logging.rs`), and the forge layer's
contract (`forge/`: the normalized types the UI sees, the `ForgeProvider` trait, the hub that holds
accounts, the cache). Core never speaks HTTP; it defines traits that the other crates implement.

**`gitvolt-forge`** implements that contract for real forges: `github.rs` (GitHub REST, and GraphQL where REST lacks it),
`gitlab.rs` (GitLab REST v4), one HTTP client per account (`http.rs`), the token store
(`tokens.rs`), avatar and Markdown-image fetching, and Gravatar (`gravatar.rs`). It depends on core,
never the other way round.

**`gitvolt-app`** is the desktop binary (`gitvolt`). Its code is a library (`src/lib.rs`, whose
`run` is the binary's `main` and, on Windows, the DLL entry point CEF's sandbox bootstrap calls). It
builds the `Api` with the real
implementations (system openers, the folder-picker portal, Gravatar, the forge connector and the
keyring token store), starts the CEF runtime with a required sandbox, registers a single Tauri
command, forwards the event bus to the webview, and handles startup and shutdown (askpass mode,
the single-instance guard, letting a running write finish before exit). `desktop.rs` sets the
window's desktop identity and the environment children get back; `window_state.rs` restores the
window's size and position.

**`gitvolt-harness`** serves the same `Api` over a WebSocket so the UI can run in a plain browser
with no Tauri, and adds a fake GitHub/GitLab, fixture repositories and test-only routes. It's what
the Playwright suite drives; see [Testing](#testing).

**`gitvolt-graph`** is the graph's pure pipeline: the walk's order, the pinned trunk, the WIP rows,
the lane layout and the labels, from plain data (`GraphInput`) to `GraphPayload`, with no gix and no
I/O. Core reads the repository with gix and calls it (`snapshot.rs`); **`gitvolt-graph-wasm`**
compiles it to WebAssembly (`just demo-wasm`) for the website demo, whose in-browser backend
(`ui/src/demo/`: `DemoTransport` over isomorphic-git) answers the UI's requests from repository
bundles. Its writes run on the same in-memory repositories: a sequencer for rebases, cherry-picks
and reverts built on a three-way tree merge, and fetch and push between in-memory git dirs (a remote
that isn't one is "Not in the demo"). A fake GitLab in the page holds the harness fake forge's data
and answers as the GitLab provider maps them. It also acts on the bundle's in-memory origin: a merge
or GitLab's rebase writes commits there, and a push to an MR's branch moves the MR and runs its
pipeline. A scripted teammate pushes one commit to Orbital's origin, so a fetch has something to
bring in. Nothing the demo does reaches the network. The demo's parity suite compares its answers
to the core's (`just demo-golden`); the forge's effects on the origin are off there, since the
harness's fake forge has none.

**`site/`** is the website: one static page (Vite, plain TypeScript and CSS) that embeds the demo
build in an iframe in its hero. Its features and GitKraken table are generated from README.md, and
its downloads from `site/data/release.json`, at build time; its screenshots come from the demo
build (`just site-shots`).

**`ui/`** is React 19, TypeScript and Vite, with zustand for state. It's organized by feature
(`graph/`, `diff/`, `stage/`, `forge/`, `markdown/`, `settings/`, …). Each feature module
registers its actions, menus and UI slots at import time (`ui/src/app/features.ts` lists them), so
the command palette, menus and shortcuts all draw from one registry, and features don't edit each
other's files. Per-tab view state (selection, open diff, caches) lives in a store per tab
(`app/tabStores.ts`). Monaco, Shiki and Mermaid load lazily; `ui/scripts/check-entry-chunk.mjs`
fails the build if Monaco or Shiki reach the startup bundle.

`vendor/tauri-runtime-cef/` is a patched copy of Tauri's CEF runtime; `GITVOLT-PATCH.md` there says
what changed and why. Why CEF and not WebKitGTK is in
[docs/decisions/cef-over-webkitgtk.md](docs/decisions/cef-over-webkitgtk.md).

## The process model

GitVolt runs as one Chromium process tree. CEF starts its renderer, GPU and utility helpers by
re-running the same `gitvolt` binary with a `--type=` argument; the entry point sends those off to
CEF before any app code runs. On Linux the runtime uses `SandboxPolicy::Required`: without a usable
sandbox the app refuses to start rather than run Chromium unsandboxed (see
[docs/dev-setup.md](docs/dev-setup.md) for the setuid helper a dev build needs).

Before any window, `main` also checks two other ways the binary can be started:
- **As askpass.** Git and ssh run `gitvolt` itself as their credential prompt (see
  [Askpass](#askpass)). In that mode it asks the running app and exits.
- **As a second launch.** One GitVolt runs per config directory, guarded by a lock and a socket
  (`$XDG_RUNTIME_DIR/gitvolt-instance-<hash of the config dir>.{lock,sock}`). A second launch on
  the same config dir hands its path (argv or `GITVOLT_OPEN`) to the running one, which opens it in
  a tab and comes to the front, and exits 0. `GITVOLT_MULTI_INSTANCE=1` skips the guard (both
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
startup, so `SSH_AUTH_SOCK` and `PATH` additions apply even when GitVolt starts from a desktop
launcher). A profile's extra gitconfig is passed as `-c include.path=…`.

### Writes

Every write runs the git CLI, never gix, and every write goes through one function, `run_write`
(`write/mod.rs`). A write is a `WriteIntent`; only the write module can mint the `WriteToken` that
`GitInvocation::write` requires, so a read path can't build a write by accident. An API test
(`WRITE_METHODS` in `api.rs`) checks that every method either is a declared write or never writes.

Why the CLI: GitVolt should behave exactly as `git` does in a terminal. Hooks (pre-commit,
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

**Submodules** are offered only in a worktree that uses them (`submodules.rs`: a `.gitmodules` or
a gitlink in its index, reported per worktree by `repoInfo`). A WIP submodule row carries
`git status`'s state of it, and its diff sides name each commit's subject from the submodule's
own repository. Update (`git submodule update --init --recursive`) and Sync URLs are writes like
any other (`write/submodules.rs`); Update runs as a network command, as a push, and asks first
when it would leave a submodule's commits on no branch behind. Neither is journaled.

### Undo and redo

The journal (`journal/`) records GitVolt's own operations, one file per worktree in the data dir
(`<data>/journal/<hash>.json`, mode 0600), never inside `.git`. It keeps the last 50 operations. An
entry holds the ref moves (applied back with compare-and-swap, so a change made outside GitVolt
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
point at the `gitvolt` binary itself (`SSH_ASKPASS_REQUIRE=force`, so ssh uses it with or without
`DISPLAY`; OpenSSH 8.4+).

When git runs it, the binary connects to the app's per-session Unix socket
(`$XDG_RUNTIME_DIR/gitvolt-askpass-<pid>-<rand>.sock`, mode 0600, removed on exit), sends the
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

In a fork the default pair is the original project's trunk first, then the local main (even when
main tracks the fork's own main, which is never pinned): diverged, the original's commits run down
lane 0 and main's own take lane 1. `snapshot::fork_of` tells a fork from cached data only, never a
request:
- **By the forge** (`ForgeHub::cached_forks`): a remote whose project is a fork of another
  remote's, and which is yours: `origin`, or a remote the original's local trunk branch tracks or
  pushes to (`branch.<name>.pushRemote`, `remote.pushDefault`). A maintainer with a contributor's
  fork as a remote isn't in a fork.
- **By convention**, else: a remote named `upstream` next to `origin`, unless a forge account
  covers origin's host (then the forge's data alone decides), the forge knows origin's project
  isn't a fork, or `upstream` is origin's own project under another URL (same host and path).

The graph payload reports the fork (`ForkPayload`: the remotes, how it was told, both trunks, the
original's host kind), whatever the pin. The commit panel uses it to note a commit on the fork's
trunk branches (a pull or merge request usually starts from a branch of its own).

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
is confirmed against a digest of `git status`, so churn in ignored files and GitVolt's own reads
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
with GitVolt's own hunk and line staging actions. Syntax highlighting is Shiki's TextMate grammars
bridged into Monaco (`diff/monaco/shiki.ts`, `@shikijs/monaco`), with the Oniguruma WASM loaded on
the first diff. The core supplies changed-file lists and both sides' contents; the UI never
re-derives which blobs to compare. A side that is a Git LFS pointer is read as its real file from
the local LFS store (`lfs.rs`, `blob::resolve`), or comes back marked as not downloaded.

**Images** (`ui/src/image/`) compare side by side, with a swipe, as onion skin, or as a pixel
difference, with zoom. **Binary** files show in a hex view: the core makes capped hex dumps
(`hex.rs`) and two read-only Monaco panes show hex and text, scrolled together, changed bytes
marked.

**Rendered Markdown** (`ui/src/markdown/`) is used for `.md` files, their diffs, and MR/PR text:
1. **Parse**: unified with `remark-parse` and `remark-gfm`, plus GitVolt's plugins for emoji,
   issue/MR references, heading ids and an autolink guard (`parse.ts`). A file's YAML (`---`) or
   TOML (`+++`) front matter becomes a key/value table (`remark-frontmatter`, then `yaml` or
   `smol-toml`; `plugins/frontmatter.ts`); MR/PR text keeps it as typed, as the forges do. Up to 16 KiB parses on the main
   thread in an idle callback; longer texts parse in a Web Worker (`parse.worker.ts`) and arrive in
   chunks that render progressively.
2. **Sanitize**: `remark-rehype`, `rehype-raw` (inline HTML becomes real nodes), then
   `rehype-sanitize` with GitHub's schema, tightened (`sanitize.ts`): no `style` or form
   attributes, ids prefixed `user-content-`, links limited to http(s), mailto and relative, and
   `data:` images limited to raster formats.
3. **Render** to React with `hast-util-to-jsx-runtime`, with GitVolt components for code blocks
   (Shiki), links, images and Mermaid diagrams.
4. **Diff** (`markdown/diff/`): the old and new trees are aligned block by block (paragraphs,
   headings, list items, table rows), similar blocks are paired and word-diffed with `jsdiff`, and
   the result renders inline or side by side. Very long blocks aren't word-diffed, and an
   alignment that takes too long falls back to the source diff.

**CSV and TSV** files (`ui/src/table/`) show as a table, Markdown's `Source | Rendered` control
labelled Table with its own pick: GitVolt's own RFC 4180 parser (`csv.ts`), a grid that renders
only the rows in view (`@tanstack/react-virtual`), and in Diff View a row diff (`rowDiff.ts`: rows
lined up with `jsdiff`, a changed row's cells marked). Parsing is on the main thread, so the limits
(`limits.ts`) show the source instead: over 8 MB, over 500 columns, more rows than a grid can lay
out, or, for a diff, over 50,000 rows a side. The body publishes which it shows (`tableStatus.ts`),
and the toolbar goes by that.

Remote images in Markdown are fetched by the core, not the webview: a forge's own image hosts
through that account's provider, any other host only when the user chooses to load it.

**Rendered HTML** (`.html`, `.htm`, `.xhtml`; `ui/src/diff/pageDoc.ts`, `HtmlPage.tsx`) has
Markdown's `Source | Rendered` toggle with a pick of its own, Source by default. The page shows as a static document in an
`<iframe sandbox>` with no permissions, through `srcdoc`, with its scripts and handlers taken out
and a stricter Content Security Policy added first. Its relative images and stylesheets are read
from the repository and inlined; anything on http(s) doesn't load, and a bar names those hosts
with an Open in browser action. A diff shows the old and new pages side by side.

## Forge layer

GitHub and GitLab are the two providers (`gitvolt-forge`), both over personal access tokens. Core
holds the `ForgeHub` (`forge/hub.rs`): the active profile's accounts, a provider per account built
on first use, and each account's last known status. It maps each remote to its forge project and
answers the MR/PR badges, the sidebar list, the MR/PR view, the Create MR/PR flow, stacked
MRs/PRs and inline review comments (`forge/mrs.rs`, `forge/create.rs`, `forge/stack.rs`,
`forge/review.rs`: the lines a forge's diff takes comments on, positions and GitLab line codes,
drafts and their submit). The UI keeps one review session per tab (`ui/src/forge/review/`), and the
diff view draws its threads and drafts (`ui/src/diff/review/`).

**HTTP** (`gitvolt-forge/src/http.rs`): one client per account with bearer auth, an ETag cache
(`If-None-Match`, so an unchanged answer is a cheap 304), the forges' poll-interval hints, rate
limits (once limited, requests fail fast until the reset time), timeouts, and
`User-Agent: GitVolt/<version>`.

**Tokens** (`gitvolt-forge/src/tokens.rs`) live in the system Secret Service through the `keyring`
crate (service `gitvolt`, account `<profile id>/<host>`). Where there's no Secret Service, they go
to `~/.local/share/gitvolt/forge-tokens` (file 0600, directory 0700), and Settings › Accounts warns
about it. Tokens never go in settings files, and nothing logs, prints or formats one.

**Cache** (`forge/cache.rs`): per project, the last MR/PR lists and badge lookups with their ETags,
in `<data dir>/forge-cache/`. A relaunch shows the last list at once, and its first poll
revalidates instead of downloading everything again. It holds the forge's own data, never a token.

**Polling** (`ui/src/forge/poller.ts`): only the active tab polls, when it becomes active, on the
fetch timer (at most once a minute, and only while the window has the focus), when the window gets
the focus back, and after a GitVolt forge action. While a visible MR/PR's pipeline runs, it polls
faster (20 s, backing off to 2 min). A failed poll keeps the data shown.

## Updates

`gitvolt-core/src/updates/` checks GitHub Releases for a newer version (SemVer; a local build's
`+<stamp>` doesn't count), downloads the package for the install kind into the cache, keeps it only
if the release's `SHA256SUMS` matches, and installs it (`pkexec apt`/`dnf`/`zypper`/`pacman` on Linux, the
installer on Windows, a copy of the `.dmg`'s GitVolt.app over the running bundle on macOS). The
fetching is `gitvolt-forge/src/updates.rs`, through the forge HTTP client without a token; the
commands run through an `UpdateRunner` the app supplies (the harness only records them). The
install kind comes from `install-kind` beside the binary (in `Contents/Resources` on macOS),
which the packages write (docs/releasing.md). The UI's pill and dialog are in `ui/src/updates/`; progress
arrives as `updateChanged` events.

## Settings, profiles and logs

| What | Where |
|---|---|
| App settings (fetch interval, prune, commit limit, date format, Gravatar, window geometry, …) | `$XDG_CONFIG_HOME/gitvolt/settings.json` |
| Profiles (tabs, recent repos, repos folder, editor, extra gitconfig, host overrides, per-repo settings) | `$XDG_CONFIG_HOME/gitvolt/profiles/<id>/profile.json` |
| Undo journal | `$XDG_DATA_HOME/gitvolt/journal/` |
| Forge cache | `$XDG_DATA_HOME/gitvolt/forge-cache/` |
| Forge tokens (only without a Secret Service) | `$XDG_DATA_HOME/gitvolt/forge-tokens` |
| Log files | `$XDG_CACHE_HOME/gitvolt/logs/gitvolt.YYYY-MM-DD.log` |
| Avatars, forge avatars, "open old version" copies, the downloaded update | `$XDG_CACHE_HOME/gitvolt/{avatars,forge-avatars,open,updates}/` |
| Chromium profile | `$XDG_CACHE_HOME/com.gitvolt.desktop/cef/` |

GitVolt was called GitBolt before 0.7.0. Its first start moves GitBolt's folders (`gitbolt`, and
Chromium's `dev.gitbolt.desktop`) to these, by a rename, or by a copy checked file by file before
the original goes (`crates/gitvolt-core/src/migrate.rs`). A folder GitVolt already has is left
alone, and nothing moves while GitBolt runs: a running GitBolt (its own lock, `gitbolt-instance-*`) takes the launch, and one that holds the lock but doesn't answer for 10 s refuses it (exit 1; the reason is also in `gitvolt-refused-start-<user>.txt` in the temp dir, outside every folder that moves). `GITVOLT_MULTI_INSTANCE` skips that check: such a start moves nothing. When a move fails, GitVolt's new folder is marked
(`.gitbolt-not-moved`), and the next start sets it aside (`<folder>.not-moved-<time>`, kept) and
tries again, for a week (the marker's age); after that GitBolt's folder stays as it is.

The XDG defaults are `~/.config`, `~/.local/share` and `~/.cache`. Settings and profiles are
written debounced and flushed once more on exit. To run a second instance without touching your
own, point `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_DATA_HOME` at throwaway directories.

**Logs** rotate daily; 7 files and 50 MB at most are kept. The level is `info`; Settings › Advanced ›
Debug logging switches to `debug` live, and `RUST_LOG` applies until it does. A release build writes
to the console only when `RUST_LOG` is set. Help → Debug… opens the Debug modal: the last 1000 git
commands, the actions you ran, the activity log of fetches and clones, **Copy diagnostics**
(versions, OS, Chromium, git and the settings, with secrets removed) and **Open logs folder**.

**Folder picker.** Open folder… calls xdg-desktop-portal's `FileChooser` over D-Bus
(`crates/gitvolt-core/src/openers/folder_picker.rs`), parented to the main window, rather than a
GTK 3 dialog that would clash with CEF's GTK 4. Without a portal, it picks nothing and logs a
warning.

## Testing

Tests live in three layers. Use the cheapest one that proves the behavior.

- **Rust** (`cargo nextest run --workspace`, or `just test-rust`): unit tests next to the code, on
  throwaway repositories from `gitvolt_core::testing` (`TestRepo`, deterministic fixtures with
  fixed dates and an environment isolated from your git config and ssh agent). Each fixture is
  built once into `target/fixture-cache/` and copied for each test (`testing/cache.rs`). The
  harness's integration tests are one test binary, `crates/gitvolt-harness/tests/it/`, one module
  per area: `cargo nextest run -p gitvolt-harness -E 'test(/^forge_stacks::/)'`.
- **UI unit tests** (vitest with jsdom, `just test-ui`): components and logic, next to the source
  as `*.test.ts(x)`.
- **End to end** (Playwright, `just e2e`, `ui/e2e/`): the real UI against the real backend
  through the harness.

`testdata/` holds JSON test vectors that both the Rust and the TypeScript tests check, so the two
sides of a shared rule can't drift.

**The harness.** `gitvolt-harness serve [--port N] [--config-dir DIR]` serves `Api::dispatch`
over a WebSocket (`/ws`: `{id, req}` in, `{id, ok|err}` and `{event}` out), so the UI runs in an
ordinary browser. It uses a throwaway config dir (never `~/.config/gitvolt`), a temp home and
runtime dir, an isolated git environment and no avatar provider. It starts with background fetch
off, records "Open in…" launches instead of running them, and refuses writes to any repository
that isn't a marked fixture. Test-only routes: `POST /test/reset`, `/test/emit`, `/test/next-pick`,
`/test/write`, `GET /test/watched`, `GET /launches`, `ANY /test/auth/*` (always 401), and the fake
forge's `/test/forge/{seed,script,requests,account}`. `gitvolt-harness fixture <name> <dir>` builds
a fixture repository (the showcase ones, for previews, submodules and LFS: [docs/playground.md](docs/playground.md)).

**The fake forge** (`crates/gitvolt-harness/src/fake_forge/`) answers the subset of the GitHub and
GitLab REST APIs that the providers use, from a seed: ETags with 304s, each forge's rate-limit
headers, scripted one-shot answers (429s, 500s, poll intervals), and a request log that records
whether a valid token came but never the token. It runs on its own ephemeral port. The harness's
connector points the real providers at it and can reach no other host, and its tokens go in a file
in the temp dir, never the system keyring.

**Fixtures** are made once per e2e run with `gitvolt-harness fixture` (a copy from the fixture
cache) and copied for each test
that needs a fresh one (`freshFixture` in `ui/e2e/fixtures.ts`).

**Playwright** runs on one worker against a production build of the UI (`vite build --mode e2e`,
rebuilt only when its inputs change), with three projects: `chromium` (what CEF embeds, the main
target), `chromium-budget` (tests tagged `@budget` that assert latency budgets, run last), and
`webkit` for engine portability. `docs/dev-setup.md` covers the options: running one spec, traces,
the dev server, and ports for running from several worktrees at once.
