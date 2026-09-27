# Dev setup: CEF sandbox

`gitbolt-app` runs on the Tauri CEF runtime, which is a Chromium build. Unbundled runs (`just dev`,
`just build-app` / `just run-app`) need Chromium's root-owned setuid `chrome-sandbox` helper —
Ubuntu restricts unprivileged user namespaces, so without it Chromium's sandbox can't start and
the app either won't launch or (never do this) has to run with the sandbox disabled.

Packages: the `.deb` payload itself ships `chrome-sandbox` as root:root, mode 4755 (the Tauri
bundler writes the tar entry that way; there is no post-install script involved). The `.rpm`
bundler also marks the file setuid (`0o104755`), but that path is **unverified**: nobody has
installed a GitBolt `.rpm` and checked the helper yet.

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

Never set the runtime's sandbox policy to `Disabled` as a default or in committed code
(`crates/gitbolt-app/src/main.rs` leaves it at `Cef::default()`, i.e. `SandboxPolicy::Auto` —
sandboxed wherever the runtime can). If you need a one-off unsandboxed run for a specific
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
