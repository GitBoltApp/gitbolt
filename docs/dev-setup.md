# Dev setup: CEF sandbox

`gitbolt-app` runs on the Tauri CEF runtime, which is a Chromium build. Unbundled runs (`just dev`,
`just build-app` / `just run-app`) need Chromium's root-owned setuid `chrome-sandbox` helper —
Ubuntu restricts unprivileged user namespaces, so without it Chromium's sandbox can't start and
the app either won't launch or (never do this) has to run with the sandbox disabled.

Packages: the `.deb` payload itself ships `chrome-sandbox` as root:root, mode 4755 (the Tauri
bundler writes the tar entry that way; there is no post-install script involved), so a packaged
`.deb` needs no setup. Only the `.deb` is built for now (`.rpm` and AppImage are deferred). The
app uses `SandboxPolicy::Required` on Linux: it refuses to start rather than run unsandboxed.

**Symptom:** an unbundled run without a usable setuid helper opens no window and exits with code 133.
The only message is Chromium's `FATAL:...] No usable sandbox!`, and GitBolt itself prints nothing
more useful. **Fix:** install the helper once (see "Recommended" below), or fix the copy next to the
binary (see "Fallback").

A local dev build is different: **every time the CEF build script runs (first build, clean
build, CEF upgrade) it copies a fresh, non-setuid `chrome-sandbox` from the CEF distribution next
to the binary** (`target/debug/` or `target/release/`). There are two ways to deal with that.

## Recommended: install the helper once (no sudo on rebuilds)

Chromium also looks for the helper at `$CHROME_DEVEL_SANDBOX`, but only when there is **no**
`chrome-sandbox` next to the executable: a helper next to the binary always wins, and if it isn't
root-owned setuid Chromium aborts ("The SUID sandbox helper binary was found, but is not
configured correctly"). Verified against the CEF 152 build in use: with the build's copy moved
away, Chromium reads `CHROME_DEVEL_SANDBOX`; with it present, the variable is ignored.

One time, after any build that has produced `target/release/chrome-sandbox` (e.g. `just build-app`):

```bash
sudo install -D -o root -g root -m 4755 target/release/chrome-sandbox /usr/local/lib/gitbolt/chrome-sandbox
```

From then on `just dev` and `just run-app` see `/usr/local/lib/gitbolt/chrome-sandbox`, export
`CHROME_DEVEL_SANDBOX` pointing at it, and delete the build's non-setuid copy next to the binary
before launching. The sandbox stays **on**; only the helper's location changes.

- If a `just dev` run still aborts with "found, but is not configured correctly", that build just
  re-ran the CEF build script and copied a fresh helper back; run `just dev` again.
- Re-run the `sudo install` after a CEF upgrade, so the helper matches the Chromium it serves.
- To go back to the per-build flow below, `sudo rm /usr/local/lib/gitbolt/chrome-sandbox`.

## Fallback: fix the helper next to the binary after every rebuild

Without the installed helper, redo this after each rebuild, for whichever target directory you
just built:

```bash
# after `just build-app` (target/release):
sudo chown root:root target/release/chrome-sandbox && sudo chmod 4755 target/release/chrome-sandbox

# after `just dev` or a plain `cargo build -p gitbolt-app` (target/debug):
sudo chown root:root target/debug/chrome-sandbox && sudo chmod 4755 target/debug/chrome-sandbox
```

## Never disable the sandbox in committed code

Never set the runtime's sandbox policy to `Disabled` as a default or in committed code.
`crates/gitbolt-app/src/main.rs` sets `SandboxPolicy::Required` on Linux, so a missing helper
stops the app instead of silently dropping the sandbox, which `Auto` would do. If you need a one-off unsandboxed run for a specific
measurement (e.g. reading `/proc/<pid>/smaps_rollup` for PSS, which is unreadable for a sandboxed,
non-dumpable renderer), that's a manual, temporary override you make yourself, not something to
land in the repo.

## Other prerequisites

- `libgtk-4-dev` and `patchelf` (`sudo apt install libgtk-4-dev patchelf`) — the CEF runtime uses
  GTK 4, not WebKitGTK.
- The v3-alpha `cargo tauri` CLI, pinned to match the vendored runtime:
  `cargo install tauri-cli --version =3.0.0-alpha.3 --locked` (`justfile`'s `dev`/`build-app`
  recipes check for exactly `tauri-cli 3.0.0-alpha.3` and tell you the command if it's missing
  or the wrong version).
- The first build downloads the CEF distribution (~320 MB compressed) into `~/.cache/tauri-cef`;
  after that, rebuilds are incremental.

## Dock and app-grid icon (unbundled builds)

The window names itself `gitbolt` (X11 `WM_CLASS`, set in `crates/gitbolt-app/src/desktop.rs`)
and carries a 256 px window icon (`_NET_WM_ICON`, Tauri's default window icon: the first PNG in
`tauri.conf.json`'s `bundle.icon`). An X11 taskbar can show that, but **Wayland docks need the
`.desktop` file to show the icon**: Wayland has no window-icon property, so GNOME and KDE match
the window to a `.desktop` entry by its class/app id (`StartupWMClass=gitbolt`) and show that
entry's `Icon=`. (The CEF window runs through XWayland, where a shell may fall back to
`_NET_WM_ICON` for an unmatched window, but pinning, the app grid and a reliable dock icon all
need the entry.) An unbundled build has no entry until you install one.

From the main checkout, after `just build-app`:

```bash
just install-desktop     # ~/.local/share/applications/gitbolt.desktop + hicolor icons
just uninstall-desktop   # removes them again
```

Both honour `XDG_DATA_HOME` (default `~/.local/share`). The entry runs `just run-app` in this
checkout. Re-run `just install-desktop` after regenerating the icons; GNOME may need you to log
out and back in before it picks up a changed icon. The `.deb` installs its own entry (`GitBolt.desktop`);
run `just uninstall-desktop` before installing it so the local entry can't shadow it.

## Running `just e2e`

`just e2e` builds the harness, then runs the Playwright projects on one worker: `chromium`, then
`chromium-budget` (the tests tagged `@budget`, which assert a latency budget, run last so a
loaded run doesn't trip them), then `webkit`. Arguments go to Playwright:
`just e2e --project=chromium --project=chromium-budget`, `just e2e e2e/diff.spec.ts`,
`just e2e -g 'K7'`.

- **The UI is a production build**, not the Vite dev server: `vite build --mode e2e` into
  `ui/dist-e2e`, served by `vite preview`. The build is redone only when its inputs change
  (`ui/src`, the build config, the lockfile: `ui/e2e/build-ui.mjs`), so a one-spec run starts in
  seconds. The `e2e` mode keeps the test hooks (`window.__gb`) that the release bundle compiles
  out. `GITBOLT_E2E_DEV=1` tests the dev server instead (unminified, for debugging a spec);
  `GITBOLT_E2E_REBUILD=1` forces a fresh build.
- **Traces are off.** Recording one for every test (to keep the failures') took about half the
  run's CPU time. A failure still leaves a screenshot under `ui/test-results/`. To get its trace,
  rerun the spec with `GITBOLT_E2E_TRACE=1` and open it with `npx playwright show-trace`.
- **Fixtures** are built once per run by `gitbolt-harness fixture` and copied for each test that
  asks for a fresh one (`freshFixture` in `ui/e2e/fixtures.ts`): `cp -a`, the copy's absolute
  paths repointed, its index refreshed.
- `expect.poll` (from `ui/e2e/test.ts`) retries every 100 ms instead of Playwright's back-off to
  once a second.

### From parallel worktrees

`just e2e` starts the `gitbolt-harness` WebSocket server and the UI server on fixed ports
(7433 and 1420 by default). Two `just e2e` runs on those same ports collide, so if you're running
the suite from more than one git worktree at once (e.g. parallel agents), give each worktree a
distinct `GITBOLT_E2E_PORT_BASE`:

```bash
# worktree A
just e2e
# worktree B (concurrently)
GITBOLT_E2E_PORT_BASE=7600 just e2e
# worktree C (concurrently)
GITBOLT_E2E_PORT_BASE=7700 just e2e
```

Setting `GITBOLT_E2E_PORT_BASE=N` runs the harness on port `N` and the UI on port `N+1`; leave it
unset to keep the defaults (7433 / 1420). Pick bases far enough apart that `N` and `N+1` don't
overlap another worktree's pair -- e.g. 7500, 7600, 7700. This only affects `just e2e`; `just dev`
and the packaged app are unaffected and always use 1420.

## Plan 1C runtime notes

- **Open Repository screen** (Ctrl+O, or the automatic tab of an empty profile): Recent (pinned
  first, filterable), "Your repos" (a scan of the profile's default repos folder; a banner offers
  to set one), **Open folder…** and Clone. Any folder inside a repository opens that repository;
  a linked worktree opens as its own tab.
- **Folder picker:** a direct D-Bus call to xdg-desktop-portal's
  `org.freedesktop.portal.FileChooser` (zbus, `crates/gitbolt-core/src/openers/folder_picker.rs`),
  parented to the main window (`x11:<xid>`). No GTK 3 dialog, which would clash with the CEF
  runtime's GTK 4. It needs `xdg-desktop-portal` plus a desktop backend (GNOME:
  `xdg-desktop-portal-gnome`; KDE: `-kde`), which standard desktops already run. Without a portal,
  **Open folder…** picks nothing and logs a warning.
- **Settings and profiles:** `$XDG_CONFIG_HOME/gitbolt` (`~/.config/gitbolt`): `settings.json`
  (app-wide: fetch interval, prune, commit limit, date format, Gravatar, window geometry) and
  `profiles/<id>/profile.json` (tabs, recent repos, repos folder, editor, extra gitconfig, host
  overrides, per-repo settings). Written debounced and flushed once more on exit. The Settings
  dialog is Ctrl+, (or the hamburger's File menu). The CEF profile is
  `$XDG_CACHE_HOME/dev.gitbolt.desktop/cef`, avatars and "open old version" copies are under
  `$XDG_CACHE_HOME/gitbolt`. To run a second instance without touching your own, point
  `XDG_CONFIG_HOME`, `XDG_CACHE_HOME` and `XDG_DATA_HOME` at throwaway dirs.
- **Single instance:** one GitBolt runs per config dir (a lock and a socket,
  `$XDG_RUNTIME_DIR/gitbolt-instance-<hash of the config dir>.{lock,sock}`). A second launch on
  the same config dir hands its path (argv or `GITBOLT_OPEN`) to the running one, which opens it
  in a tab and comes to the front, and exits 0. So `just dev` or `just run-app` with your own config
  while an installed GitBolt runs only focuses that one: use throwaway XDG dirs, or
  `GITBOLT_MULTI_INSTANCE=1` (both then write the same settings files, the last write wins).
- **Command palette:** Ctrl+P. Prefixes narrow it to one group: `>` actions, `@` branches and
  tags, `/` files at HEAD, `#` settings (opens the Settings dialog on that setting).
- **Askpass:** git and ssh run the `gitbolt` binary itself as `GIT_ASKPASS`/`SSH_ASKPASS`
  (`SSH_ASKPASS_REQUIRE=force`, so ssh uses it with or without `DISPLAY`; OpenSSH 8.4+). The
  per-session socket is `$XDG_RUNTIME_DIR/gitbolt-askpass-<pid>-<rand>.sock` (mode 0600, removed
  on exit). Fetch and clone run with `GIT_TERMINAL_PROMPT=0`, stdin closed and in their own
  session (`setsid`, no controlling terminal), so no prompt can wait on a tty, even when GitBolt
  was started from a shell. A user-started fetch or clone shows the credential modal; background
  fetches never prompt: one that needs credentials is reported as skipped in the status bar until
  a fetch succeeds. To try it without your real keys, see "Trying the askpass flow" below.
- **Background fetch:** `git fetch --all` of the **active** tab's repo every
  `fetchIntervalSecs` (default 60; 0 is off), with `--prune` per the Prune setting,
  `--no-prune-tags`, `--no-auto-maintenance` and `--no-write-commit-graph`. It writes only
  remote-tracking refs, objects and `FETCH_HEAD`, never the worktree, the index, local branches
  or config. Ticks are skipped while the window is minimized and replayed on focus. A successful
  background fetch shows nowhere but the activity log.
- **Watcher (only the active tab):** inotify, non-recursive on every tracked directory of every
  worktree (from its index) and every directory with an untracked, non-ignored file, plus `.git`,
  `.git/worktrees`, each linked worktree's gitdir and `.git/refs` (recursive). Ignored trees
  (`node_modules`, `vendor`) are never watched. Past 20 000 directories (or inotify's limit), the
  watch degrades: it still reports what it sees, and each graph build re-reads status. Inactive
  tabs aren't watched and aren't even opened until first activated.
- **Worktrees:** the sidebar's Worktrees panel lists the main and linked worktrees (the current
  one marked); a change in any of them refreshes the tab.
- **Activity log:** every finished fetch and clone, background ones included (newest first, at
  most 200), with git's message. Open it from the bell's "Activity log" submenu or Help →
  Activity log (devtools, dev builds only: `window.__gb.activity()`). Since 1D, the same modal
  is the Debug modal: Help → Debug… opens it on the **Commands** tab (git's command log, the last
  1000) or the **Actions** tab (the actions you ran). Its header has Copy diagnostics, Open logs
  folder and the Perf overlay toggle.
- **Log files (1D):** `~/.cache/gitbolt/logs/gitbolt.YYYY-MM-DD.log` (`$XDG_CACHE_HOME`
  honoured; 7 days, 50 MB total). The level is `info`; Settings → Advanced switches on `debug`
  live. `RUST_LOG` works until debug is switched on. A release build writes nothing to the
  console unless `RUST_LOG` is set. Background fetch errors go to the status bar's bell. A
  user's Fetch always says how it went: a short "Fetched: …" toast, or an 8 s "Fetch failed: …"
  toast with git's message and an "Activity log" link. A user's fetch still running after 2 s
  shows "Fetching <repo>… N%" with Cancel in the status bar.
- **Harness:** `gitbolt-harness serve [--port N] [--config-dir DIR]` uses a throwaway config dir
  (never `~/.config/gitbolt`), a temp home and runtime dir, no avatar provider, starts with
  background fetch off, records launches instead of running them, and exposes test-only routes:
  `POST /test/reset`, `/test/emit`, `/test/next-pick`, `GET /test/watched`, `GET /launches`, and
  `ANY /test/auth/*` (always 401).


## Trying the askpass flow (no real keys)

Everything lives in `/tmp/gb-askpass` and runs in a **throwaway GitBolt instance**. Neither the
setup nor that instance reads your git config:
- `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` keep out `~/.gitconfig`, so no
  `credential.helper store`, no signing and no 1Password.
- Throwaway `XDG_*` dirs give a fresh default profile, with no extra gitconfig and none of your
  tabs or recent repos.

Nothing here touches `~/.ssh`, your ssh agent, `~/.git-credentials`, `~/.config/gitbolt` or a
real repository. (This holds unless your shell's startup files set `GIT_CONFIG_GLOBAL`
themselves: GitBolt runs git with your login shell's environment.)

`scripts/fake-ssh` stands in for ssh. It asks for a key passphrase the way OpenSSH decides
(through `SSH_ASKPASS`), then serves a local bare repo, so no sshd or key is needed. It needs a
release build (`just build-app`).

**1. Set up a throwaway repo whose remote is "ssh".** Paste this as is: it runs in a subshell, so
your shell keeps its own directory and environment.

```sh
(
  set -e
  export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
  GB=~/repos/gitbolt          # your GitBolt checkout
  T=/tmp/gb-askpass
  id="-c user.name=gb-test -c user.email=gb-test@example.invalid"
  rm -rf $T && mkdir -p $T
  git init -q --bare -b main $T/origin.git
  git init -q -b main $T/seed
  git -C $T/seed $id commit -q --allow-empty -m first
  git -C $T/seed push -q $T/origin.git main
  git clone -q $T/origin.git $T/work
  git -C $T/work remote set-url origin ssh://fake$T/origin.git
  git -C $T/work config ssh.variant simple
  git -C $T/work config core.sshCommand "$GB/scripts/fake-ssh --passphrase testpass"
  git -C $T/work config credential.helper ""      # belt and braces: no helper, even if one slipped in
  git -C $T/seed $id commit -q --allow-empty -m "new upstream commit"
  git -C $T/seed push -q $T/origin.git main
)
```

**2. Start the throwaway instance** on that repo. Your usual GitBolt can stay open.

```sh
env GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
  XDG_CONFIG_HOME=/tmp/gb-askpass/xdg/config XDG_CACHE_HOME=/tmp/gb-askpass/xdg/cache XDG_DATA_HOME=/tmp/gb-askpass/xdg/data \
  just --justfile ~/repos/gitbolt/justfile run-app /tmp/gb-askpass/work &
```

Its git sees no credential helper at all. To check, run this; it prints only the repo's own
empty `credential.helper` line (config, never credentials):

```sh
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 git -C /tmp/gb-askpass/work config --show-origin --get-all credential.helper
```

**3. SSH key passphrase.** The first background fetch can't prompt, so the status bar says
"Fetch skipped: authentication required"; that's expected. Click **Fetch**:

- The modal asks "Enter passphrase for key '/tmp/gb-askpass-key'". Type `testpass`: the toast says
  "Fetched: remote changes", and "new upstream commit" shows on `origin/main`.
- Click **Fetch** again and type anything else: the toast says "Fetch failed: Authentication failed
  (fake: Permission denied (publickey).)". Its **Activity log** link lists every fetch and how it
  went.
- Press Esc in the modal: the fetch is cancelled quietly (no toast).

**4. A dead agent, and a stuck remote.** A dead agent is what 1Password closed looks like to an
ssh remote:

```sh
git -C /tmp/gb-askpass/work config core.sshCommand "$HOME/repos/gitbolt/scripts/fake-ssh --dead-agent"
```

**Fetch** shows "Fetch failed: Authentication failed (fake: Permission denied (publickey).)". For a
stuck remote, use `--hang` instead: **Fetch** spins, and after 2 s the status bar shows "Fetching
work…" with **Cancel**, which stops it.

**5. HTTPS username and password.** Start an always-401 server (its PID goes in a file, so any
shell can stop it), then point the repo at it:

```sh
python3 -c 'import http.server as h
class H(h.BaseHTTPRequestHandler):
    def do_GET(s): s.send_response(401); s.send_header("WWW-Authenticate", "Basic realm=gitbolt-test"); s.send_header("Content-Length", "0"); s.end_headers()
    def log_message(s, *a): pass
h.HTTPServer(("127.0.0.1", 8765), H).serve_forever()' & echo $! > /tmp/gb-askpass/server.pid
git -C /tmp/gb-askpass/work config --unset core.sshCommand
git -C /tmp/gb-askpass/work remote set-url origin http://127.0.0.1:8765/x.git
```

In the throwaway instance, **Fetch** asks "Username for 'http://127.0.0.1:8765'", then the
password, then fails with "Fetch failed: Authentication failed (…)". No credential helper is
consulted, so whatever you type is never stored, and `~/.git-credentials` is never opened.

**6. Clean up:** quit the throwaway instance, then run
`kill "$(cat /tmp/gb-askpass/server.pid)"; rm -rf /tmp/gb-askpass`.

A real ssh key with a passphrase isn't covered here. It would be
`ssh-keygen -t ed25519 -N testpass -f /tmp/gb-askpass-key`, then
`core.sshCommand = ssh -i /tmp/gb-askpass-key -o IdentitiesOnly=yes -o IdentityAgent=none`. But it
needs an sshd that accepts that key: ssh only asks for the passphrase after the server accepts
the public key.

Why the throwaway instance and `GIT_CONFIG_GLOBAL=/dev/null` rather than just a repo-local
`credential.helper ""`:
- That reset does work against `~/.gitconfig` (git 2.53, checked).
- But GitBolt passes the active profile's extra gitconfig as `-c include.path=…`. That is read
  after the repo's config, so a helper set there comes back.
- With such a helper, git still calls it to `get` and, after a 401, to `erase`; `store` rewrites
  `~/.git-credentials` on erase.
- A fresh profile has no extra gitconfig, and `/dev/null` has no helper.

## Packaging (`just package`)

- Builds the `.deb` into `target/release/bundle/deb/`. `scripts/fix-deb.sh` then rewrites its
  `Depends`: dpkg-shlibdeps results plus `libgtk-4-1` and `git (>= 1:2.30)`, without the
  `libgtk-3-0` the alpha CLI always adds (upstream draft: `docs/upstream/tauri-cli-cef-gtk-depends.md`).
  `scripts/check-deb.sh` verifies that, that `chrome-sandbox` is root:root 4755, and that the
  package carries the hicolor PNGs, the scalable SVG and a desktop entry with
  `Categories=...Development;` and `StartupWMClass=gitbolt`.
- `scripts/test-fix-deb.sh` (part of `just test`) checks `fix-deb.sh` on a synthetic package.
  It needs `dpkg-dev`; without it, it skips and exits 0.
- The package is `git-bolt` (about 146 MiB). It installs `/usr/share/GitBolt/` (the binary and
  CEF, `chrome-sandbox` root:root 4755) and `/usr/bin/gitbolt` as a symlink to it.
- **Install and check:**
  1. Quit any running GitBolt that uses your config. With the single-instance guard, a running
     one would just be focused instead of the installed app starting.
  2. Run `just uninstall-desktop`, so the dev entry doesn't duplicate or shadow the `.deb`'s
     `GitBolt.desktop`.
  3. Run `sudo apt install ./target/release/bundle/deb/GitBolt_0.1.0_amd64.deb`, then launch
     GitBolt from the app menu.
  4. Run `GITBOLT_PID=<browser pid> scripts/check-sandbox.sh`, which checks that every renderer has
     seccomp and its own PID namespace. Then `GITBOLT_PID=<browser pid> just bench`. The browser
     process is the `/usr/share/GitBolt/gitbolt` process without a `--type=` argument.
- **Remove it:** `sudo apt remove git-bolt`. Then `just install-desktop` brings the dev entry back.

## `just bench` (idle CPU and memory smoke)

A small, non-gating check of the two spec §17.3 rows that need a live app. It runs
`scripts/measure-idle.sh 60` and `scripts/measure-mem.sh` against a running instance and prints
each next to its budget (idle CPU < 1.5%, memory with 12 tabs < 650 MB). It never fails on a
number.

```
# the browser process: a gitbolt process without --type= (CEF's helpers re-run the same binary)
GITBOLT_PID=$(for p in $(pgrep -x gitbolt); do grep -qa -- --type= /proc/$p/cmdline || echo $p; done | head -1)
echo "$GITBOLT_PID"; GITBOLT_PID=$GITBOLT_PID just bench
```

`pgrep -nx gitbolt` alone isn't enough: it returns the newest `gitbolt` process, which is usually a
renderer.

- `GITBOLT_PID` is the instance's browser (main) process; it scopes the scripts to that instance
  and its CEF children. Start the instance yourself (`just run-app`, with any throwaway XDG dirs
  you like), open the tabs to measure, and leave the window focused and idle for the 60 s.
- The other §17.3 rows are asserted by `just e2e` (`menu-perf.spec`, the `tabs.spec` switch) and
  the opt-in, read-only `real-repo.spec` timings. There's no generator or statistics.
