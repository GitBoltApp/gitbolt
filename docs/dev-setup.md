# Dev setup: CEF sandbox

`gitbolt-app` runs on the Tauri CEF runtime, which is a Chromium build. Unbundled runs (`just dev`,
`just build-app` / `just run-app`) need Chromium's root-owned setuid `chrome-sandbox` helper —
Ubuntu restricts unprivileged user namespaces, so without it Chromium's sandbox can't start and
the app either won't launch or (never do this) has to run with the sandbox disabled.

Packages: the `.deb` payload itself ships `chrome-sandbox` as root:root, mode 4755 (the Tauri
bundler writes the tar entry that way; there is no post-install script involved), so a packaged
`.deb` needs no setup, and neither does the Arch package built from it. There is no `.rpm` or
AppImage build. The app uses `SandboxPolicy::Required` on Linux: it refuses to start rather than run unsandboxed.

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
`crates/gitbolt-app/src/lib.rs` sets `SandboxPolicy::Required` on Linux, so a missing helper
stops the app instead of silently dropping the sandbox, which `Auto` would do. If you need a one-off unsandboxed run for a specific
measurement (e.g. reading `/proc/<pid>/smaps_rollup` for PSS, which is unreadable for a sandboxed,
non-dumpable renderer), that's a manual, temporary override you make yourself, not something to
land in the repo.

## Other prerequisites

- `libgtk-4-dev` and `patchelf` (`sudo apt install libgtk-4-dev patchelf`) — the CEF runtime uses
  GTK 4, not WebKitGTK.
- The v3-alpha `cargo tauri` CLI, pinned to match the vendored runtime:
  `cargo install tauri-cli --version =3.0.0-alpha.4 --locked` (`justfile`'s `dev`/`build-app`
  recipes check for exactly `tauri-cli 3.0.0-alpha.4` and tell you the command if it's missing
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
`just e2e -g '<part of a test title>'`.

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
the suite from more than one git worktree at once, give each worktree a
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

## Build and test speed

- **Debug info.** Dev and test builds keep line tables only for our crates (backtraces and panic
  locations still give file:line) and none for dependencies (`[profile.dev]` in `Cargo.toml`):
  a worktree's `target/` is about a third the size, and links are cheaper. Run a debugger on a
  build with `CARGO_PROFILE_DEV_DEBUG=true` if you need full debug info.
- **Leave `CARGO_INCREMENTAL` unset.** Incremental builds are the default for dev builds; with them
  a one-line change in core rebuilds the test binaries in about a third of the time a
  `CARGO_INCREMENTAL=0` build takes, and clippy reruns in seconds. Never set it to `1`: sccache
  (below) refuses to run at all when it's `1`. Unset, incremental crates simply bypass sccache.
- **Release builds are incremental too** (`[profile.release] incremental = true`; still
  opt-level 3), so `just package` after a small change rebuilds in under a minute instead of
  re-optimising all of core. `just package` and `just build-app` unset `CARGO_INCREMENTAL` for
  their build so a caller's `=0` can't undo that.
- **One harness test binary.** The harness's integration tests are modules of `tests/it/`:
  `cargo test -p gitbolt-harness --test it forge_stacks::` runs one old file's tests.
- **cargo-nextest** (`cargo install --locked cargo-nextest`, or the prebuilt binary from
  nexte.st into `~/.cargo/bin`) runs the workspace's tests in under half the time of
  `cargo test` here: every test is its own process, and all the test binaries run at once instead
  of one after the other. `just test-rust` uses it when it's installed; its settings are in
  `.config/nextest.toml`. There are no doctests, so nothing is skipped.
- **Vitest** keeps its default pool (forks) and worker count. `just test-ui-changed` runs only
  the files related to what this branch changed; `just test-ui` stays the full gate.
- **sccache and mold** are optional and not configured by this repo: set them up yourself in
  `~/.cargo/config.toml`. sccache caches dependency builds across worktrees, though about a third of them
  still miss in a new worktree (their cache key includes the worktree's own paths), and it never
  caches our own incremental crates, build scripts, proc macros or test binaries. mold links a
  test binary in about 0.3 s, where GNU ld took about 10 s.

## How the app behaves at runtime

How GitBolt works inside (the request API, reads and writes, askpass, the watcher, background
fetch, where settings and logs live, the harness) is in [ARCHITECTURE.md](../ARCHITECTURE.md).
A few things that matter while developing:

- **One instance per config dir.** `just dev` or `just run-app` with your own config while an
  installed GitBolt runs only focuses that one and exits. Point `XDG_CONFIG_HOME`,
  `XDG_CACHE_HOME` and `XDG_DATA_HOME` at throwaway dirs, or set `GITBOLT_MULTI_INSTANCE=1`.
- **Open Repository** (Ctrl+O, or the automatic tab of an empty profile): Recent (pinned first,
  filterable), "Your repos" (a scan of the profile's default repos folder; a banner offers to set
  one), **Open folder…** and Clone. Any folder inside a repository opens that repository; a linked
  worktree opens as its own tab. **Open folder…** needs `xdg-desktop-portal` and a desktop backend
  (GNOME: `xdg-desktop-portal-gnome`; KDE: `-kde`), which standard desktops already run.
- **Command palette:** Ctrl+P. Prefixes narrow it to one group: `>` actions, `@` branches and
  tags, `/` files at HEAD, `#` settings (opens the Settings dialog on that setting). The Settings
  dialog itself is Ctrl+, (or the hamburger's File menu).
- **Fetch feedback:** a user's Fetch always says how it went: a short "Fetched: …" toast, or an
  8 s "Fetch failed: …" toast with git's message and an "Activity log" link. One still running
  after 2 s shows "Fetching <repo>… N%" with Cancel in the status bar. Background fetch errors go
  to the status bar's bell.
- **Activity log and Debug:** open the activity log from the bell's "Activity log" submenu or Help
  → Activity log (in dev builds, also `window.__gb.activity()` in devtools). Help → Debug… opens
  the same modal on its **Commands** tab (git's command log) or **Actions** tab.

## Trying the askpass flow (no real keys)

Everything lives in `/tmp/gb-askpass` and runs in a **throwaway GitBolt instance**. Neither the
setup nor that instance reads your git config:
- `GIT_CONFIG_GLOBAL=/dev/null` and `GIT_CONFIG_NOSYSTEM=1` keep out `~/.gitconfig`, so no
  `credential.helper store`, no signing and no password-manager ssh agent.
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

**4. A dead agent, and a stuck remote.** A dead agent is what a closed password manager's ssh
agent looks like to an ssh remote:

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
  `Depends`: dpkg-shlibdeps results plus `libgtk-4-1` and `git (>= 1:2.40)`, without the
  `libgtk-3-0` the alpha CLI always adds (upstream draft: `docs/upstream/tauri-cli-cef-gtk-depends.md`).
  `scripts/check-deb.sh` verifies that, that `chrome-sandbox` is root:root 4755, and that the
  package carries the control fields, icons, desktop entry and AppStream metainfo below, and the
  license notices and DEP-5 `copyright` file in `/usr/share/doc/gitbolt/`. It needs
  `appstreamcli` and `desktop-file-validate` (`sudo apt install appstream desktop-file-utils`).
- `fix-deb.sh` also writes the Debian form of the version: a SemVer pre-release's `-` becomes
  `~` (`0.1.0-alpha.1` → `0.1.0~alpha.1`), which sorts before `0.1.0`.
- `GITBOLT_RELEASE_VERSION=<version> just package` builds the plain, unstamped version, as the
  release workflow does; it must equal `tauri.conf.json`'s version. See
  [releasing.md](releasing.md).
- Before building, it generates the third-party license notices (`scripts/licenses.sh`, needs
  cargo-about), and fails on a dependency whose license isn't on the allow-list. See
  [licensing.md](licensing.md).
- `scripts/test-fix-deb.sh` and `scripts/test-check-deb.sh` (part of `just test`) check
  `fix-deb.sh` and `check-deb.sh` on synthetic packages. The first needs `dpkg-dev`, the second
  `appstream` and `desktop-file-utils`; without them, they skip and exit 0.
  `scripts/test-package-meta.sh` checks the metainfo and copyright generator, and validates the
  real metainfo when `appstreamcli` is installed.

### Software centres (AppStream)

Double-clicking a `.deb` opens it in the desktop's software centre. None of them reads the
package's AppStream file before it's installed:

- **GNOME Software** (50): its `dpkg` plugin runs `dpkg-deb -W` for `Package`, `Version`,
  `License`, `Installed-Size`, `Homepage` and `Description` (`plugins/dpkg/gs-plugin-dpkg.c`);
  its `packagekit` plugin asks PackageKit's `GetDetailsLocal`, whose apt backend always reports
  the license as `unknown` (`backends/apt/apt-job.cpp`, `emitPackageDetail`), and takes the app
  id from the shortest `.desktop` file name in the package (`file_to_app_get_files_cb`). An app
  without an icon then gets the generic `system-component-application`
  (`lib/gs-plugin-job-file-to-app.c`). It shows the name as the package name, `git-bolt`.
- **Ubuntu's App Center**: PackageKit's `GetDetailsLocal` only (`lib/deb/local_deb_model.dart`):
  the package name as the title, the summary and description, `Homepage`, and the license, which
  is `unknown` there too. Its local `.deb` page has no icon at all (`AppTitleBar.fromLocalDeb`).
- **KDE Discover**: PackageKit's `GetDetailsLocal` and `GetFilesLocal`
  (`LocalFilePKResource.cpp`); the file name as the name, the generic `applications-other` icon.

So for that page the control fields are what count: `fix-deb.sh` adds `License: MIT` (not a
Debian field, but GNOME Software reads it), and `tauri.conf.json` sets `Homepage` and the long
`Description`. Once installed, the software centres read
`/usr/share/metainfo/dev.gitbolt.desktop.metainfo.xml` (the id is `tauri.conf.json`'s
`identifier`):

- It's generated by `scripts/package-meta.py` from
  `crates/gitbolt-app/linux/dev.gitbolt.desktop.metainfo.xml.in`: the releases (version and date)
  from CHANGELOG.md's dated sections, and the README screenshot by its raw GitHub URL at the
  newest release's tag.
- Its `<pkgname>` is the package's name: `git-bolt` in the `.deb`, `gitbolt` in the Arch package
  (`package-arch.sh` changes it). App Center and Discover match an installed component to its
  package by it, and GNOME Software finds the package to remove that way, since no distribution
  catalog lists GitBolt.
- The desktop entry keeps its name, `GitBolt.desktop` (`linux/GitBolt.desktop.hbs`), so existing
  installs' dock pins and menu entries carry over; the metainfo's `<launchable>` names it.
- The icons are installed under the app id too (`dev.gitbolt.desktop.png` at 32 to 512 px, and
  `.svg`), which the desktop entry's `Icon=` and the metainfo name. Tauri's own `gitbolt.png` set
  stays: its bundler always installs the `bundle.icon` PNGs under the binary's name.
- `check-deb.sh` validates it (`appstreamcli validate --pedantic --no-net`) and checks it against
  the package: file name, launchable, icon, pkgname, license, and the newest release against the
  package's version.
- The package is `git-bolt` (about 146 MiB). It installs `/usr/share/GitBolt/` (the binary and
  CEF, `chrome-sandbox` root:root 4755) and `/usr/bin/gitbolt` as a symlink to it.
- **Install and check:**
  1. Quit any running GitBolt that uses your config. With the single-instance guard, a running
     one would just be focused instead of the installed app starting.
  2. Run `just uninstall-desktop`, so the dev entry doesn't duplicate or shadow the `.deb`'s
     `GitBolt.desktop`.
  3. Run `sudo apt install ./target/release/bundle/deb/GitBolt_*_amd64.deb`, then launch
     GitBolt from the app menu. The file name carries a build stamp
     (`GitBolt_0.1.0+<UTC time>.<commit>_amd64.deb`, e.g. `0.1.0+202610051325.ab4dbf9e`), and
     `just package` deletes older packages first, so the glob matches only the new one.
  4. Run `GITBOLT_PID=<browser pid> scripts/check-sandbox.sh`, which checks that every renderer has
     seccomp and its own PID namespace. Then `GITBOLT_PID=<browser pid> just bench`. The browser
     process is the `/usr/share/GitBolt/gitbolt` process without a `--type=` argument.
- **Remove it:** `sudo apt remove git-bolt`. Then `just install-desktop` brings the dev entry back.

### Arch Linux package (`just package-arch`, `just check-arch-pkg`)

- `just package` ends with `just package-arch`, so one build gives both packages. It turns the
  `.deb` into `target/release/bundle/arch/GitBolt-<ver>-1-x86_64.pkg.tar.zst` without makepkg
  (`scripts/package-arch.sh`; the Python helpers are in `scripts/arch-pkg.py`).
  - The payload is the `.deb`'s data member, path for path and mode for mode; the script checks
    that, and that `chrome-sandbox` is root:root 4755. The one addition is
    `/usr/share/licenses/gitbolt`, a symlink to the license notices in `/usr/share/doc/gitbolt`,
    and the one change is the AppStream metainfo's `<pkgname>`, which becomes `gitbolt`.
  - `license` lines: MIT, then the licenses in the Rust and UI notices' summaries, CEF and
    Chromium's `BSD-3-Clause`, and the spell-check dictionary's `LicenseRef-SCOWL`
    (`arch-pkg.py licenses`).
  - `pkgver` is the `.deb` version with `+` turned into `.` (`0.1.0+202610051325.ab4dbf9e` →
    `0.1.0.202610051325.ab4dbf9e-1`), and a pre-release's `~` dropped (`0.1.0~alpha.1` →
    `0.1.0alpha.1-1`): pacman's `vercmp` would sort `0.1.0.alpha.1` after `0.1.0`. Every entry
    gets the build stamp's time, and so does `builddate`; `$SOURCE_DATE_EPOCH` overrides it (a
    release build has no stamp: the workflow sets it to the commit time, and a local one falls
    back to the `.deb`'s mtime).
  - `depend` lines come from the `.deb`'s `Depends` through the `DEB_TO_ARCH` table in
    `scripts/arch-pkg.py`. A Debian name the table doesn't know fails the build: add a row.
  - `.MTREE` is written in Python in the format makepkg's bsdtar uses (no bsdtar on Ubuntu).
- `scripts/test-package-arch.sh` (part of `just test`) checks the version and dependency mapping,
  mtree escaping, and a synthetic `.deb` through the whole script.
- `just check-arch-pkg` installs the package in a throwaway `archlinux:latest` Docker container
  (`--rm`; it needs Docker and the network, so `just package` doesn't run it). It runs
  `pacman -Syu`, then `pacman -U`, and checks `pacman -Qkk gitbolt`, the license notices, the
  setuid `chrome-sandbox`, the AppStream metainfo (`appstreamcli validate`), desktop entry and
  icons, `ldd` on the binary and the CEF libraries, and a 20 s headless launch under `xvfb-run`.
- `packaging/arch/PKGBUILD` is a template for a future `gitbolt-bin` AUR package that repackages
  the release `.deb`. The build doesn't use it.
- **Install on Arch:** `sudo pacman -U GitBolt-<ver>-1-x86_64.pkg.tar.zst`. **Remove:**
  `sudo pacman -R gitbolt`.

## `just bench` (idle CPU and memory smoke)

A small, non-gating check of the two performance budgets that need a live app: idle CPU and
memory. It runs
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
- The other performance budgets (latencies) are asserted by `just e2e` (`menu-perf.spec`, the
  `tabs.spec` switch) and the opt-in, read-only `real-repo.spec` timings. These are single
  timings: there's no repo generator and no statistics.

## Windows

The app builds, runs and packages on Windows (x64). Needs Visual Studio's C++ Build Tools
with its Ninja on `PATH` (`…\Common7\IDE\CommonExtensions\Microsoft\CMake\Ninja`), CMake, Git for
Windows and Node.

- **CEF:** `cef-dll-sys`'s build script downloads the Windows distribution into `CEF_PATH`
  (`cargo tauri` uses `%LOCALAPPDATA%\tauri-cef`) and copies its runtime files next to the binary.
- **The UI:** `cd ui && npm ci && npm run build`.
- **Debug build with the bundled UI:** `cargo build -p gitbolt-app --features tauri/custom-protocol`
  (without the feature, a debug build loads the Vite dev server, `npm run dev`).
- **Sandboxed:** a plain debug `gitbolt.exe` runs Chromium unsandboxed, and a release one refuses
  to start (SECURITY.md). The sandbox needs the app as a DLL under CEF's bootstrap, named alike:
  ```bat
  cargo rustc -p gitbolt-app --lib --crate-type cdylib --features tauri/custom-protocol
  copy %CEF_PATH%\152.0.6\cef_windows_x86_64\bootstrapc.exe target\debug\gitbolt_app.exe
  target\debug\gitbolt_app.exe
  ```
  (`bootstrapc.exe` keeps a console; `bootstrap.exe` is the windowed host.)
- **A throwaway instance, driven from another machine:** in debug builds,
  `GITBOLT_DEV_DIRS=<absolute dir>` puts the config, cache, data and Chromium profile folders under
  that folder (Windows' Known Folders ignore the environment; set `TEMP` and `TMP` too for the
  single-instance and askpass files), and `GITBOLT_DEV_CDP_PORT=<port>` opens Chromium's DevTools
  protocol on `127.0.0.1:<port>`. Started over SSH, the app runs in the SSH session's own window
  station, not on the desktop; `ssh -L 9333:127.0.0.1:9333 <host>` and Playwright's
  `chromium.connectOverCDP('http://127.0.0.1:9333')` then reach its page. Release builds have
  neither variable.
- **The installers:** `just package-windows` (or `powershell -File scripts\package-windows.ps1`)
  builds the NSIS per-user installer and the per-machine MSI into
  `target\release\bundle\windows\`, from a release build with the sandboxed layout above
  (`GitBolt.exe` is CEF's `bootstrap.exe`, `GitBolt.dll` the app). Besides the above it needs
  Python 3 (`PYTHON` picks one), cargo-about 0.9.2 (`cargo install cargo-about --version 0.9.2
  --locked --features cli`) and the .NET SDK (WiX is a .NET tool); NSIS, WiX and rcedit are
  downloaded into `target\windows-tools` on first use. docs/releasing.md has the details, the
  versions and the signing hook.

## macOS

The app builds and runs on macOS (Apple Silicon checked, macOS 12 or later), but only as
`GitBolt.app`: CEF loads its framework and starts its helper processes from inside the bundle, so
a bare `target/debug/GitBolt` can't start. Needs Xcode's command line tools, CMake, Ninja, Node
and the pinned Tauri CLI (`cargo install tauri-cli --version =3.0.0-alpha.4 --locked`).

- **The bundle:** `cd crates/gitbolt-app && cargo tauri build --debug --bundles app` (or without
  `--debug`) makes `target/<profile>/bundle/macos/GitBolt.app`, with the UI embedded. The Tauri
  CLI does the whole layout (`tauri.macos.conf.json` adds to `tauri.conf.json`):
  - `Contents/MacOS/GitBolt`, the app (`mainBinaryName`, so the helpers are named after it);
  - `Contents/Frameworks/Chromium Embedded Framework.framework`, copied from the distribution
    `cef-dll-sys` downloaded into `CEF_PATH` (`~/Library/Caches/tauri-cef` by default);
  - `Contents/Frameworks/GitBolt Helper.app` and its `(GPU)`, `(Renderer)`, `(Plugin)` and
    `(Alerts)` siblings: one small helper executable, which the bundler compiles against the
    app's own `cef` crate (`target/tauri-cef-helper`) and copies into each, with its
    `Info.plist`;
  - `Contents/Resources/dictionaries/en-US-10-1.bdic`, the spell-check dictionary;
  - an ad-hoc signature (`signingIdentity: "-"`), inside out, with the hardened runtime and the
    entitlements CEF needs (JIT, unsigned executable memory, no library validation);
  - `Info.plist` with the folder document type (`packaging/macos/Info.plist`, merged in).
- **The package:** `just package-macos` builds the release bundle and
  `target/release/bundle/dmg/GitBolt_<version>_aarch64.dmg`, then checks both
  (`scripts/package-macos.sh`; docs/releasing.md, "macOS disk image"). It needs cargo-about too,
  for the license notices.
- **Folders from Finder:** macOS hands folders to the app as Apple Events (Open With, a folder
  dropped on the Dock icon, `open -a <bundle> <folder>`), which arrive as Tauri's
  `RunEvent::Opened` and open in a tab like a later launch's path. A launch argument still works
  when the binary is started directly.
- **The sandbox:** the helpers enter Chromium's Seatbelt sandbox, ad-hoc signed as they are; a
  release build asks for it outright (`SandboxPolicy::Required`, SECURITY.md).
- **A throwaway instance driven over CDP** (debug builds only), as on Windows:
  `GITBOLT_DEV_DIRS=<absolute dir> GITBOLT_DEV_CDP_PORT=9333 GitBolt.app/Contents/MacOS/GitBolt
  <repo>`, then `node ui/scripts/cdp-smoke.mjs 9333 <out dir> <repo>` (Playwright's
  `connectOverCDP`) opens the graph, a commit, its diff and a fetch, with a screenshot of each.
  The single-instance and askpass sockets are in `$TMPDIR`.
- **No Mac at hand:** `.github/workflows/mac-port.yml` (on demand: run it from the Actions tab,
  or `gh workflow run mac-port.yml --ref <branch>`) runs the core, forge and harness tests, a
  workspace check, and job `app`: it builds the debug bundle, launches it on the runner's own
  screen, drives it with `cdp-smoke.mjs` (a second launch and `open -a` of a folder included),
  lists the bundle, its signatures and each process's sandbox state, and uploads the screenshots
  (`macos-app`). Job `package` builds the release `.dmg` with `just package-macos`, copies its
  app to `/Applications`, launches it with `open -a` on a folder and opens a second one, checks
  the tabs (in the profile, since a release build refuses CDP) and the sandbox, then runs the
  updater's install over the running app from the same `.dmg` (`macos-package`, with the `.dmg`).
