set shell := ["bash", "-cu"]
# Only `package-windows` is meant for Windows; PowerShell there, never WSL's bash.
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

default: test

test: test-rust test-ui test-scripts

test-scripts:
    scripts/test-fix-deb.sh
    scripts/test-check-deb.sh
    scripts/test-package-meta.sh
    scripts/test-package-arch.sh
    scripts/test-licenses.sh
    scripts/test-version-order.sh
    scripts/test-release.sh

# Prepares a release on main: sets the version everywhere, dates CHANGELOG.md's Unreleased
# section, commits "Release <version>" and tags v<version>. It never pushes; it prints the push
# command, and the pushed tag builds a draft GitHub release. See docs/releasing.md.
release version:
    @scripts/release.sh "{{version}}"

# cargo-nextest when it's installed (each test its own process, every test binary at once: about
# half the wall time of `cargo test` here); otherwise plain `cargo test`. No doctests to miss.
test-rust:
    if cargo nextest --version >/dev/null 2>&1; then cargo nextest run --workspace; else cargo test --workspace; fi

test-ui:
    cd ui && npx vitest run --passWithNoTests

# Only the vitest files that import something changed since `since` (default: where this branch
# left main), plus uncommitted changes: a quick check while working. `just test-ui` stays the gate.
test-ui-changed since="":
    #!/usr/bin/env bash
    set -euo pipefail
    since="{{since}}"; [ -n "$since" ] || since="$(git merge-base HEAD main)"
    cd ui && npx vitest run --passWithNoTests --changed "$since"

gen-types:
    cargo test -p gitbolt-core export_bindings

# The Playwright suites (Chromium, its @budget latency tests, then WebKit; one worker) against a
# production build of the UI, rebuilt only when ui/src changes. Arguments go to Playwright:
# `just e2e --project=chromium --project=chromium-budget`, `just e2e e2e/diff.spec.ts`.
# GITBOLT_E2E_TRACE=1 keeps a trace of each failure (off by default:
# recording them doubles the CPU time); GITBOLT_E2E_DEV=1 tests the Vite dev server instead. Set
# GITBOLT_E2E_PORT_BASE (e.g. `GITBOLT_E2E_PORT_BASE=7600 just e2e`) to run this from several
# worktrees at once without port collisions. See docs/dev-setup.md.
e2e *args:
    cargo build -p gitbolt-harness
    cd ui && npx playwright test {{args}}

# Throwaway repos to try the app in, all direct children of one folder (so "Add a folder" lists
# them): basic, sync, conflicts, stack, wip_staging. Their local bare remotes live in .remotes/
# and linked worktrees in .worktrees/. Re-running resets them; it only ever deletes a folder that
# carries the .gitbolt-playground marker (see scripts/playground.sh).
playground dir="~/gitbolt-playground":
    @echo "building the fixture harness (first run takes a few minutes)…"
    @cargo build -p gitbolt-harness
    @scripts/playground.sh "${CARGO_TARGET_DIR:-target}/debug/gitbolt-harness" "{{dir}}"

# The theme and zoom pixel baselines (Chromium, recorded on the dev machine): opt-in, since fonts
# and antialiasing differ between machines. Add `-- --update-snapshots` to re-record them.
e2e-shots *args:
    cargo build -p gitbolt-harness
    cd ui && GITBOLT_E2E_SHOTS=1 npx playwright test --project=chromium e2e/themes.spec.ts e2e/zoom.spec.ts {{args}}

# The README's screenshot, docs/images/screenshot.webp: the made-up repos of scripts/showcase-repo.sh
# in four tabs, a commit selected, 1600x1000 (ui/e2e/readme-screenshot.spec.ts; skipped by
# `just e2e`). Reduced to 256 colours with Pillow, then oxipng or optipng when installed.
readme-screenshot:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo build -p gitbolt-harness
    tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
    (cd ui && GITBOLT_README_SHOT="$tmp/raw.png" npx playwright test --project=chromium e2e/readme-screenshot.spec.ts)
    mkdir -p docs/images
    python3 -c 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], lossless=True, method=6)' "$tmp/raw.png" docs/images/screenshot.webp
    echo "docs/images/screenshot.webp: $(du -k docs/images/screenshot.webp | cut -f1) KB"

# The CEF app needs the v3-alpha `cargo tauri` CLI, pinned to match the vendored/patched
# tauri-runtime-cef and the other Tauri crates (root Cargo.toml, vendor/tauri-runtime-cef/
# GITBOLT-PATCH.md). Install with: cargo install tauri-cli --version =3.0.0-alpha.4 --locked
check-tauri-cli:
    cargo tauri --version | grep -qxF 'tauri-cli 3.0.0-alpha.4' || { echo "wrong cargo-tauri version; install: cargo install tauri-cli --version =3.0.0-alpha.4 --locked"; exit 1; }

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
    cd crates/gitbolt-app && env -u CARGO_INCREMENTAL CARGO_BUILD_JOBS=4 cargo tauri build --no-bundle

# The .deb (AppImage and .rpm are deferred) with the GTK 4 dependency fix (spec §18): the .deb's
# control member is rewritten by scripts/fix-deb.sh and checked by scripts/check-deb.sh. Then the
# Arch package is made from it (`just package-arch`), so one build gives both.
# `env -u CARGO_INCREMENTAL` (here and in build-app): a CARGO_INCREMENTAL=0 from the caller would
# override the release profile's `incremental = true` (Cargo.toml), and sccache refuses a 1.
package: check-tauri-cli
    # Old packages first: the globs below must match only the .deb this build makes.
    rm -f target/release/bundle/deb/GitBolt_*_amd64.deb
    # The license notices, fresh for every package (docs/licensing.md): the Rust, CEF and Chromium
    # ones into target/licenses here; the UI's come from the UI build `cargo tauri build` runs.
    # Either fails the build on a license outside the allow-list in about.toml.
    scripts/licenses.sh
    # The AppStream metainfo (its releases from CHANGELOG.md) and the DEP-5 copyright file, into
    # target/package-meta for tauri.conf.json's files map (docs/dev-setup.md, "Software centres").
    mkdir -p target/package-meta
    scripts/package-meta.py metainfo crates/gitbolt-app/linux/dev.gitbolt.desktop.metainfo.xml.in CHANGELOG.md target/package-meta/dev.gitbolt.desktop.metainfo.xml
    scripts/package-meta.py copyright LICENSE target/package-meta/copyright
    # Each build gets its own, increasing version (0.1.0+<UTC time>.<sha>), so `apt install` of a
    # newer build replaces the installed one instead of skipping it as "already the newest".
    # GITBOLT_RELEASE_VERSION=<version> (the release workflow) builds the plain version instead,
    # which must equal tauri.conf.json's (scripts/package-version.sh). CARGO_BUILD_JOBS defaults to 4.
    # GITBOLT_BUILD_VERSION bakes the same version into the binary (the status bar, the update check).
    cd crates/gitbolt-app && v="$(../../scripts/package-version.sh tauri.conf.json)" && \
      env -u CARGO_INCREMENTAL CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" GITBOLT_BUILD_VERSION="$v" cargo tauri build --bundles deb --config "{\"version\":\"$v\"}"
    scripts/fix-deb.sh target/release/bundle/deb/GitBolt_*_amd64.deb
    scripts/check-deb.sh target/release/bundle/deb/GitBolt_*_amd64.deb
    scripts/package-arch.sh target/release/bundle/deb/GitBolt_*_amd64.deb target/release/bundle/arch

# The third-party license notices the packages ship (docs/licensing.md): the Rust crates, CEF and
# Chromium into target/licenses (scripts/licenses.sh, needs cargo-about), then the UI build, which
# writes ui/dist/licenses/THIRD-PARTY-NOTICES-ui.txt. Fails on a license outside the allow-list in
# about.toml. `just package` runs the same steps.
licenses:
    scripts/licenses.sh
    cd ui && npm run build

# The Arch package (target/release/bundle/arch/GitBolt-<ver>-1-x86_64.pkg.tar.zst), made from the
# .deb of `just package` without makepkg: same payload, pacman's .PKGINFO and .MTREE, Depends
# mapped through the table in scripts/arch-pkg.py. `just package` already runs it.
package-arch:
    scripts/package-arch.sh target/release/bundle/deb/GitBolt_*_amd64.deb target/release/bundle/arch

# On Windows: the NSIS per-user installer and the per-machine MSI, from one release build, in
# target\release\bundle\windows\ (scripts/package-windows.ps1 has the steps and requirements).
# CEF's bootstrap.exe runs as GitBolt.exe and loads gitbolt-app built as GitBolt.dll, which
# gives Chromium its sandbox. Versions as in `just package`; GITBOLT_SIGN_COMMAND signs.
package-windows:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/package-windows.ps1

# On macOS: target/release/bundle/dmg/GitBolt_<version>_aarch64.dmg (x64 on an Intel Mac), the
# release GitBolt.app, ad-hoc signed, beside a link to /Applications; then its checks
# (scripts/package-macos.sh). Versions as in `just package`.
package-macos: check-tauri-cli
    scripts/package-macos.sh

# Installs that package in a throwaway archlinux:latest container and checks it (needs Docker and
# the network, so `just package` doesn't run it): dependencies, pacman -Qkk, the setuid
# chrome-sandbox, ldd, and a headless launch. See scripts/check-arch-pkg.sh.
check-arch-pkg:
    scripts/check-arch-pkg.sh target/release/bundle/arch/GitBolt-*-x86_64.pkg.tar.zst

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
