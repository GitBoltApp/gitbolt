set shell := ["bash", "-cu"]

default: test

test: test-rust test-ui test-scripts

test-scripts:
    scripts/test-fix-deb.sh

test-rust:
    cargo test --workspace

test-ui:
    cd ui && npx vitest run --passWithNoTests

gen-types:
    cargo test -p gitbolt-core export_bindings

# Set GITBOLT_E2E_PORT_BASE (e.g. `GITBOLT_E2E_PORT_BASE=7600 just e2e`) to run this from
# several git worktrees at once without port collisions -- see docs/dev-setup.md. Unset, ports
# default to 7433 (harness) / 1420 (Vite), unchanged.
e2e:
    cargo build -p gitbolt-harness
    cd ui && npx playwright test

# The theme and zoom pixel baselines (Chromium, recorded on the dev machine): opt-in, since fonts
# and antialiasing differ between machines. Add `-- --update-snapshots` to re-record them.
e2e-shots *args:
    cargo build -p gitbolt-harness
    cd ui && GITBOLT_E2E_SHOTS=1 npx playwright test --project=chromium e2e/themes.spec.ts e2e/zoom.spec.ts {{args}}

# The CEF app needs the v3-alpha `cargo tauri` CLI, pinned to match the vendored/patched
# tauri-runtime-cef and the other Tauri crates (root Cargo.toml, vendor/tauri-runtime-cef/
# GITBOLT-PATCH.md). Install with: cargo install tauri-cli --version =3.0.0-alpha.3 --locked
check-tauri-cli:
    cargo tauri --version | grep -qxF 'tauri-cli 3.0.0-alpha.3' || { echo "wrong cargo-tauri version; install: cargo install tauri-cli --version =3.0.0-alpha.3 --locked"; exit 1; }

# The installed copy of Chromium's setuid sandbox helper (one-time `sudo install`, see
# docs/dev-setup.md). When it exists, the run recipes point Chromium at it through
# CHROME_DEVEL_SANDBOX and delete the build's fresh non-setuid copy next to the binary:
# Chromium always prefers a helper next to the executable when one exists (and aborts if it
# isn't root-owned setuid), and only reads CHROME_DEVEL_SANDBOX when there's none. The sandbox
# stays on either way; this only changes where the helper lives, so rebuilds need no sudo.
sandbox_helper := "/usr/local/lib/gitbolt/chrome-sandbox"

dev repo="": check-tauri-cli
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -e "{{sandbox_helper}}" ]; then export CHROME_DEVEL_SANDBOX="{{sandbox_helper}}"; rm -f target/debug/chrome-sandbox; fi
    cd crates/gitbolt-app && GITBOLT_OPEN="{{repo}}" CARGO_BUILD_JOBS=4 cargo tauri dev

# Release build of the CEF app, unbundled (matches the spike's build flow). The first build
# downloads the CEF distribution (~320 MB) into ~/.cache/tauri-cef. Needs libgtk-4-dev and
# patchelf. Unbundled runs need the sandbox helper: either the one-time install above (then use
# `just run-app`), or a root-owned setuid chrome-sandbox next to the binary after every build.
# See docs/dev-setup.md and docs/decisions/cef-over-webkitgtk.md.
build-app: check-tauri-cli
    cd crates/gitbolt-app && CARGO_BUILD_JOBS=4 cargo tauri build --no-bundle

# The .deb (AppImage and .rpm are deferred) with the GTK 4 dependency fix (spec §18): the .deb's
# control member is rewritten by scripts/fix-deb.sh and checked by scripts/check-deb.sh.
package: check-tauri-cli
    # Old packages first: the globs below must match only the .deb this build makes.
    rm -f target/release/bundle/deb/GitBolt_*_amd64.deb
    cd crates/gitbolt-app && CARGO_BUILD_JOBS=4 cargo tauri build --bundles deb
    scripts/fix-deb.sh target/release/bundle/deb/GitBolt_*_amd64.deb
    scripts/check-deb.sh target/release/bundle/deb/GitBolt_*_amd64.deb

# Runs the release binary from `just build-app`, with the installed sandbox helper if present.
run-app repo="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -e "{{sandbox_helper}}" ]; then export CHROME_DEVEL_SANDBOX="{{sandbox_helper}}"; rm -f target/release/chrome-sandbox; fi
    GITBOLT_OPEN="{{repo}}" target/release/gitbolt

# A desktop entry for the unbundled release build (H13): the dock and the app grid then show
# GitBolt's icon and match its window (StartupWMClass = the window's WM_CLASS, set in
# crates/gitbolt-app/src/desktop.rs). Writes only under $XDG_DATA_HOME (default
# ~/.local/share): applications/gitbolt.desktop and icons/hicolor/<size>/apps/gitbolt.png, plus
# the scalable source.svg. It launches this checkout's release binary (target/release/gitbolt,
# from `just build-app`) through `just run-app`, so the sandbox helper setup stays in one place.
# The .deb has its own entry (Tauri's bundler writes it). Run it from the MAIN checkout: Exec
# bakes in this checkout's path, and a `.claude/worktrees/` worktree is temporary (the entry
# would point at a removed directory later). Re-run it after regenerating the icons.
# `just uninstall-desktop` removes exactly what it writes.
desktop_icons := "32x32:32x32.png 64x64:64x64.png 128x128:128x128.png 256x256:128x128@2x.png 512x512:icon.png"

install-desktop:
    #!/usr/bin/env bash
    set -euo pipefail
    case "{{justfile_directory()}}" in
      */.claude/worktrees/*) echo "warning: this is a temporary worktree ({{justfile_directory()}}); the entry's Exec points here. Run 'just install-desktop' from the main checkout instead." >&2 ;;
    esac
    [ -x "{{justfile_directory()}}/target/release/gitbolt" ] || echo "note: target/release/gitbolt isn't built yet; run 'just build-app' before launching it from the dock." >&2
    data="${XDG_DATA_HOME:-$HOME/.local/share}"; apps="$data/applications"; icons="$data/icons/hicolor"
    mkdir -p "$apps"
    for size in {{desktop_icons}}; do
      dir="$icons/${size%%:*}/apps"; mkdir -p "$dir"
      cp "{{justfile_directory()}}/crates/gitbolt-app/icons/${size#*:}" "$dir/gitbolt.png"
    done
    mkdir -p "$icons/scalable/apps"
    cp "{{justfile_directory()}}/crates/gitbolt-app/icons/source.svg" "$icons/scalable/apps/gitbolt.svg"
    printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=GitBolt' 'Comment=Git GUI' \
      'Exec="{{just_executable()}}" --justfile "{{justfile()}}" run-app' 'Icon=gitbolt' \
      'StartupWMClass=gitbolt' 'Categories=Development;RevisionControl;' 'Terminal=false' \
      > "$apps/gitbolt.desktop"
    command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true
    command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$icons" || true
    echo "Wrote $apps/gitbolt.desktop (Exec: just run-app in {{justfile_directory()}})"

uninstall-desktop:
    #!/usr/bin/env bash
    set -euo pipefail
    data="${XDG_DATA_HOME:-$HOME/.local/share}"; apps="$data/applications"; icons="$data/icons/hicolor"
    rm -f "$apps/gitbolt.desktop" "$icons/scalable/apps/gitbolt.svg"
    for size in {{desktop_icons}}; do rm -f "$icons/${size%%:*}/apps/gitbolt.png"; done
    [ -d "$apps" ] && command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true
    [ -d "$icons" ] && command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$icons" || true
    echo "Removed GitBolt's desktop entry and icons from $data"

lint:
    cargo clippy --workspace --all-targets -- -D warnings
    cd ui && npx tsc --noEmit

# A smoke check of the two §17.3 rows that need a live app (idle CPU, memory). Non-gating: it
# prints numbers next to the budgets and never fails on them. Point GITBOLT_PID at the browser
# process of a running instance (open the tabs you want measured first): the gitbolt process
# without `--type=` (not `pgrep -nx`, which finds a renderer; docs/dev-setup.md has a
# one-liner). The other rows are asserted by `just e2e`
# (menu-perf, tabs) and the opt-in real-repo spec. See docs/dev-setup.md.
bench:
    #!/usr/bin/env bash
    set -uo pipefail
    : "${GITBOLT_PID:?set GITBOLT_PID to a running GitBolt browser process (see docs/dev-setup.md)}"
    export GITBOLT_PID
    echo "== idle CPU, 60 s (budget < 1.5%; keep the window focused and idle) =="
    scripts/measure-idle.sh 60 || echo "(measure-idle failed)"
    echo
    echo "== memory (budget < 650 MB with 12 tabs open) =="
    scripts/measure-mem.sh || echo "(measure-mem failed)"
    echo
    echo "Budgets: idle CPU < 1.5%, memory (12 tabs) < 650 MB (spec §17.3). Informational only."
