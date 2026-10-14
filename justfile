set shell := ["bash", "-cu"]
# Only `package-windows` is meant for Windows; PowerShell there, never WSL's bash.
set windows-shell := ["powershell.exe", "-NoLogo", "-NoProfile", "-Command"]

default: test

test: test-rust test-ui test-demo test-scripts test-site

test-scripts:
    scripts/test-fix-deb.sh
    scripts/test-check-deb.sh
    scripts/test-package-meta.sh
    scripts/test-package-arch.sh
    scripts/test-package-rpm.sh
    scripts/test-licenses.sh
    scripts/test-version-order.sh
    scripts/test-release.sh
    scripts/test-site-shots.sh
    scripts/test-site-release.sh
    scripts/test-workflows.sh
    scripts/test-windows-installers.sh
    scripts/test-name.sh

# Prepares a release on main: sets the version everywhere, dates CHANGELOG.md's Unreleased
# section, commits "Release <version>" and tags v<version>. It never pushes; it prints the push
# command, and the pushed tag builds a draft GitHub release. See docs/releasing.md.
release version:
    @scripts/release.sh "{{version}}"

# cargo-nextest when it's installed (each test its own process, every test binary at once: about
# half the wall time of `cargo test` here); otherwise plain `cargo test`. No doctests to miss.
test-rust:
    if cargo nextest --version >/dev/null 2>&1; then cargo nextest run --workspace; else cargo test --workspace; fi

# Optional, not part of `just test` or CI: builds Orbital, checks `ref` (main's tip by default, or
# a tag: `just orbital-test v1.0.0`) out into a temp dir and runs `cargo test --workspace` on
# Orbital's own crates (needs crates.io for glam, wgpu, ...).
orbital-test ref="main":
    #!/usr/bin/env bash
    set -euo pipefail
    tmp="$(mktemp -d)"; trap 'rm -rf "$tmp"' EXIT
    repo="$(cargo run -q -p gitvolt-harness -- showcase orbital "$tmp/build")"
    git clone -q "$repo" "$tmp/checkout"
    cd "$tmp/checkout" && git checkout -q "{{ref}}" && cargo test --workspace

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
    cargo test -p gitvolt-core -p gitvolt-graph export_bindings

# The graph pipeline as WebAssembly for the website demo (crates/gitvolt-graph-wasm) into
# ui/src/demo/wasm/ (git-ignored): the wasm-bindgen glue, and the .wasm gzipped (GitHub Pages
# doesn't compress it; the demo unpacks it with DecompressionStream). Also writes the notices of
# the crates it holds, failing on a license about.toml doesn't accept. Needs the wasm32 target
# and the pinned wasm-bindgen CLI (docs/dev-setup.md).
wasm_bindgen_version := "0.2.129"

demo-wasm:
    #!/usr/bin/env bash
    set -euo pipefail
    rustup target list --installed | grep -qx wasm32-unknown-unknown || { echo "missing the wasm32 target; install: rustup target add wasm32-unknown-unknown"; exit 1; }
    wasm-bindgen --version 2>/dev/null | grep -qxF 'wasm-bindgen {{wasm_bindgen_version}}' || { echo "wrong or missing wasm-bindgen CLI; install: cargo install wasm-bindgen-cli --version {{wasm_bindgen_version}} --locked"; exit 1; }
    # Remap the build machine's paths (serde's panic locations) out of the binary.
    RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=${CARGO_HOME:-$HOME/.cargo}=/cargo --remap-path-prefix=$PWD=/gitvolt" \
      cargo build --release --locked -p gitvolt-graph-wasm --target wasm32-unknown-unknown
    target_dir="${CARGO_TARGET_DIR:-target}"
    out=ui/src/demo/wasm
    rm -rf "$out" && mkdir -p "$out"
    wasm-bindgen --target web --omit-default-module-path --out-dir "$out" "$target_dir/wasm32-unknown-unknown/release/gitvolt_graph_wasm.wasm"
    gzip -9 -n "$out/gitvolt_graph_wasm_bg.wasm"
    cargo about generate --format json --locked --fail -c about.toml --target wasm32-unknown-unknown -m crates/gitvolt-graph-wasm/Cargo.toml -o "$out/about.json"
    python3 scripts/notices.py rust "$out/about.json" "$out/THIRD-PARTY-NOTICES-wasm.txt"
    rm "$out/about.json"
    echo "$out/gitvolt_graph_wasm_bg.wasm.gz: $(du -k "$out/gitvolt_graph_wasm_bg.wasm.gz" | cut -f1) KB"

# The website demo's parity data (ui/src/demo/golden/): each fixture with a request list in
# requests/ built by the harness, packed (<fixture>.gbdemo) and answered by the real core
# (<fixture>/<n>.json), plus the core's default settings and a demo manifest. Rerun when the
# core's answers or the fixtures change, and commit the result.
demo-golden:
    cargo build -p gitvolt-harness
    node ui/scripts/demo-golden.mjs

# The website demo (ui/demo.html, `vite build --mode demo`) into site/dist/demo/, with the data in
# site/demo-data/ (GITVOLT_DEMO_DATA=<folder> picks another, e.g. ui/src/demo/golden).
demo-build: demo-wasm
    cd ui && npx vite build --mode demo

# The website demo's vitest suites, with the WebAssembly graph built first (without it the graph
# and parity tests skip).
test-demo: demo-wasm
    cd ui && npx vitest run src/demo

# The website demo's Playwright smoke test (ui/e2e-demo/, its own config: it serves a demo build
# over the parity suite's fixtures, not the harness). Arguments go to Playwright.
e2e-demo *args: demo-wasm
    cd ui && npx playwright test -c playwright.demo.config.ts {{args}}

# The site's screenshots (site/shots/*.webp; spec §2 decision 6): headless Chromium on the demo
# build, on demand only (never in CI), each saved at 2x and 1x as WebP (Pillow). A scene whose demo
# methods are still pending (ui/src/demo/coverage.ts) is skipped. Commit the result. Arguments go
# to Playwright (`just site-shots -g image` retakes one).
site-shots *args: demo-build
    #!/usr/bin/env bash
    set -euo pipefail
    tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
    (cd site && GITVOLT_SITE_SHOTS_RAW="$tmp" npx playwright test -c playwright.shots.config.ts --workers=1 {{args}})
    python3 scripts/site-shots.py "$tmp" site/shots

# The site's social-sharing image (site/public/og.jpg, og:image): site/og/og.html, drawn with the
# page's tokens, fonts and art and the hero screenshot, rendered by headless Chromium
# (site/scripts/og-image.ts) and saved as a JPEG under 300 KB (Pillow). On demand: rerun after the
# hero shot or the brand changes, and commit the result.
site-og:
    #!/usr/bin/env bash
    set -euo pipefail
    [ -d site/node_modules ] || (cd site && npm ci)
    tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
    node site/scripts/og-image.ts "$tmp/og.png"
    python3 scripts/site-og.py "$tmp/og.png" site/public/og.jpg

# The website's Playwright checks (site/e2e/, its own config): the built site and demo, served as
# static files: no request to another origin, no console error, the downloads from release.json,
# the live demo booting and resetting, a phone getting the still. Arguments go to Playwright.
e2e-site *args: site-build demo-build
    cd site && npx playwright test --workers=1 {{args}}

# The website's landing page (site/: Vite, plain TypeScript and CSS) into site/dist/. The demo is
# built separately into site/dist/demo/ (either order). Then the page's own checks (nothing left
# unfilled, the first screen's weight); the whole Pages artefact is `just site-pages`.
site-build:
    [ -d site/node_modules ] || (cd site && npm ci)
    cd site && npx vite build
    node site/scripts/check-page.ts site/dist

# The page's dev server (http://localhost:1430), with the last `just demo-build` at /demo/.
site-dev:
    cd site && npx vite

# The website's unit tests (site/: its page code, build code and scripts).
test-site:
    [ -d site/node_modules ] || (cd site && npm ci)
    cd site && npx vitest run

# The website as GitHub Pages serves it, into site/dist/: the landing page, the demo (its
# WebAssembly built first) and the 404 page, then its checks (ui/scripts/check-site.mjs: links,
# no third-party requests, image sizes, size budgets). The local dry run of a deploy; see
# docs/website.md.
site-pages:
    scripts/site-pages.sh

# The Playwright suites (Chromium, its @budget latency tests, then WebKit; one worker) against a
# production build of the UI, rebuilt only when ui/src changes. Arguments go to Playwright:
# `just e2e --project=chromium --project=chromium-budget`, `just e2e e2e/diff.spec.ts`.
# GITVOLT_E2E_TRACE=1 keeps a trace of each failure (off by default:
# recording them doubles the CPU time); GITVOLT_E2E_DEV=1 tests the Vite dev server instead. Set
# GITVOLT_E2E_PORT_BASE (e.g. `GITVOLT_E2E_PORT_BASE=7600 just e2e`) to run this from several
# worktrees at once without port collisions. See docs/dev-setup.md.
e2e *args:
    cargo build -p gitvolt-harness
    cd ui && npx playwright test {{args}}

# Throwaway repos to try the app in, all direct children of one folder (so "Add a folder" lists
# them): orbital, basic, sync, conflicts, stack, wip_staging, rebase-lab, previews, submodules,
# lfs (`gitvolt-harness showcase`). Their local bare remotes live in .remotes/ and linked
# worktrees in .worktrees/. Re-running resets them; it only ever deletes a folder that
# carries the .gitvolt-playground marker (see scripts/playground.sh).
playground dir="~/gitvolt-playground":
    @echo "building the fixture harness (first run takes a few minutes)…"
    @cargo build -p gitvolt-harness
    @scripts/playground.sh "${CARGO_TARGET_DIR:-target}/debug/gitvolt-harness" "{{dir}}"

# The demo's repositories (site/demo-data/*.gbdemo and manifest.json): each showcase repo built
# with the harness and packed with ui/scripts/pack-demo.mjs; one whose content didn't change keeps
# its committed bundle. Fails over the 15 MB budget. See docs/playground.md.
demo-data:
    cargo build -p gitvolt-harness
    node ui/build/demoBundles.ts "${CARGO_TARGET_DIR:-target}/debug/gitvolt-harness" site/demo-data

# The theme and zoom pixel baselines (Chromium, recorded on the dev machine): opt-in, since fonts
# and antialiasing differ between machines. Add `-- --update-snapshots` to re-record them.
e2e-shots *args:
    cargo build -p gitvolt-harness
    cd ui && GITVOLT_E2E_SHOTS=1 npx playwright test --project=chromium e2e/themes.spec.ts e2e/zoom.spec.ts {{args}}

# The README's screenshot, docs/images/screenshot.webp: the made-up repos of scripts/showcase-repo.sh
# in seven tabs in three groups (Web collapsed); driftwood on the harness's fake GitHub with three open PRs, a
# linked worktree, Stashes collapsed, a commit selected with its files as a tree; 1600x1000
# (ui/e2e/readme-screenshot.spec.ts; skipped by `just e2e`). Reduced to 256 colours with Pillow, then oxipng or optipng when installed.
readme-screenshot:
    #!/usr/bin/env bash
    set -euo pipefail
    cargo build -p gitvolt-harness
    tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
    (cd ui && GITVOLT_README_SHOT="$tmp/raw.png" npx playwright test --project=chromium e2e/readme-screenshot.spec.ts)
    mkdir -p docs/images
    python3 -c 'import sys; from PIL import Image; Image.open(sys.argv[1]).convert("RGB").save(sys.argv[2], lossless=True, method=6)' "$tmp/raw.png" docs/images/screenshot.webp
    echo "docs/images/screenshot.webp: $(du -k docs/images/screenshot.webp | cut -f1) KB"

# The CEF app needs the v3-alpha `cargo tauri` CLI, pinned to match the vendored/patched
# tauri-runtime-cef and the other Tauri crates (root Cargo.toml, vendor/tauri-runtime-cef/
# GITVOLT-PATCH.md). Install with: cargo install tauri-cli --version =3.0.0-alpha.4 --locked
check-tauri-cli:
    cargo tauri --version | grep -qxF 'tauri-cli 3.0.0-alpha.4' || { echo "wrong cargo-tauri version; install: cargo install tauri-cli --version =3.0.0-alpha.4 --locked"; exit 1; }

# The installed copy of Chromium's setuid sandbox helper (one-time `sudo install`, see
# docs/dev-setup.md). When it exists, the run recipes point Chromium at it through
# CHROME_DEVEL_SANDBOX and delete the build's fresh non-setuid copy next to the binary:
# Chromium always prefers a helper next to the executable when one exists (and aborts if it
# isn't root-owned setuid), and only reads CHROME_DEVEL_SANDBOX when there's none. The sandbox
# stays on either way; this only changes where the helper lives, so rebuilds need no sudo.
sandbox_helper := "/usr/local/lib/gitvolt/chrome-sandbox"

dev repo="": check-tauri-cli
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -e "{{sandbox_helper}}" ]; then export CHROME_DEVEL_SANDBOX="{{sandbox_helper}}"; rm -f target/debug/chrome-sandbox; fi
    cd crates/gitvolt-app && GITVOLT_OPEN="{{repo}}" CARGO_BUILD_JOBS=4 cargo tauri dev

# Release build of the CEF app, unbundled (matches the spike's build flow). The first build
# downloads the CEF distribution (~320 MB) into ~/.cache/tauri-cef. Needs libgtk-4-dev and
# patchelf. Unbundled runs need the sandbox helper: either the one-time install above (then use
# `just run-app`), or a root-owned setuid chrome-sandbox next to the binary after every build.
# See docs/dev-setup.md and docs/decisions/cef-over-webkitgtk.md.
build-app: check-tauri-cli
    cd crates/gitvolt-app && env -u CARGO_INCREMENTAL CARGO_BUILD_JOBS=4 cargo tauri build --no-bundle

# The .deb (AppImage is deferred) with the GTK 4 dependency fix (spec §18): the .deb's control
# member is rewritten by scripts/fix-deb.sh and checked by scripts/check-deb.sh. Then the Arch
# package and the RPM are made from it (`just package-arch`, `just package-rpm`), so one build
# gives all three.
# `env -u CARGO_INCREMENTAL` (here and in build-app): a CARGO_INCREMENTAL=0 from the caller would
# override the release profile's `incremental = true` (Cargo.toml), and sccache refuses a 1.
package: check-tauri-cli
    # Old packages first: the globs below must match only the .deb this build makes.
    rm -f target/release/bundle/deb/GitVolt_*_amd64.deb
    # The license notices, fresh for every package (docs/licensing.md): the Rust, CEF and Chromium
    # ones into target/licenses here; the UI's come from the UI build `cargo tauri build` runs.
    # Either fails the build on a license outside the allow-list in about.toml.
    scripts/licenses.sh
    # The AppStream metainfo (its releases from CHANGELOG.md) and the DEP-5 copyright file, into
    # target/package-meta for tauri.conf.json's files map (docs/dev-setup.md, "Software centres").
    mkdir -p target/package-meta
    scripts/package-meta.py metainfo crates/gitvolt-app/linux/com.gitvolt.desktop.metainfo.xml.in CHANGELOG.md target/package-meta/com.gitvolt.desktop.metainfo.xml
    scripts/package-meta.py copyright LICENSE target/package-meta/copyright
    # Each build gets its own, increasing version (0.1.0+<UTC time>.<sha>), so `apt install` of a
    # newer build replaces the installed one instead of skipping it as "already the newest".
    # GITVOLT_RELEASE_VERSION=<version> (the release workflow) builds the plain version instead,
    # which must equal tauri.conf.json's (scripts/package-version.sh). CARGO_BUILD_JOBS defaults to 4.
    # GITVOLT_BUILD_VERSION bakes the same version into the binary (the status bar, the update check).
    cd crates/gitvolt-app && v="$(../../scripts/package-version.sh tauri.conf.json)" && \
      env -u CARGO_INCREMENTAL CARGO_BUILD_JOBS="${CARGO_BUILD_JOBS:-4}" GITVOLT_BUILD_VERSION="$v" cargo tauri build --bundles deb --config "{\"version\":\"$v\"}"
    scripts/fix-deb.sh target/release/bundle/deb/GitVolt_*_amd64.deb
    scripts/check-deb.sh target/release/bundle/deb/GitVolt_*_amd64.deb
    scripts/package-arch.sh target/release/bundle/deb/GitVolt_*_amd64.deb target/release/bundle/arch
    scripts/package-rpm.sh target/release/bundle/deb/GitVolt_*_amd64.deb target/release/bundle/rpm

# The third-party license notices the packages ship (docs/licensing.md): the Rust crates, CEF and
# Chromium into target/licenses (scripts/licenses.sh, needs cargo-about), then the UI build, which
# writes ui/dist/licenses/THIRD-PARTY-NOTICES-ui.txt. Fails on a license outside the allow-list in
# about.toml. `just package` runs the same steps.
licenses:
    scripts/licenses.sh
    cd ui && npm run build

# The Arch package (target/release/bundle/arch/GitVolt-<ver>-1-x86_64.pkg.tar.zst), made from the
# .deb of `just package` without makepkg: same payload, pacman's .PKGINFO and .MTREE, Depends
# mapped through the table in scripts/arch-pkg.py. `just package` already runs it.
package-arch:
    scripts/package-arch.sh target/release/bundle/deb/GitVolt_*_amd64.deb target/release/bundle/arch

# The RPM for Fedora, RHEL and openSUSE (target/release/bundle/rpm/GitVolt-<version>-1.x86_64.rpm),
# made from the .deb of `just package` without rpmbuild: same payload less the system directories,
# Requires from the ELF files in rpm's form, the notices as %license files (scripts/rpm-pkg.py).
# `just package` already runs it.
package-rpm:
    scripts/package-rpm.sh target/release/bundle/deb/GitVolt_*_amd64.deb target/release/bundle/rpm

# On Windows: the NSIS per-user installer and the per-machine MSI, from one release build, in
# target\release\bundle\windows\ (scripts/package-windows.ps1 has the steps and requirements).
# CEF's bootstrap.exe runs as GitVolt.exe and loads gitvolt-app built as GitVolt.dll, which
# gives Chromium its sandbox. Versions as in `just package`; GITVOLT_SIGN_COMMAND signs.
package-windows:
    powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File scripts/package-windows.ps1

# On macOS: target/release/bundle/dmg/GitVolt_<version>_aarch64.dmg (x64 on an Intel Mac), the
# release GitVolt.app, ad-hoc signed, beside a link to /Applications; then its checks
# (scripts/package-macos.sh). Versions as in `just package`.
package-macos: check-tauri-cli
    scripts/package-macos.sh

# Installs that package in a throwaway archlinux:latest container and checks it (needs Docker and
# the network, so `just package` doesn't run it): dependencies, pacman -Qkk, the setuid
# chrome-sandbox, ldd, and a headless launch. See scripts/check-arch-pkg.sh.
check-arch-pkg:
    scripts/check-arch-pkg.sh target/release/bundle/arch/GitVolt-*-x86_64.pkg.tar.zst

# Installs the RPM in a throwaway fedora:latest container and checks it (Docker and the network, so
# `just package` doesn't run it): rpm -K, dnf resolving every Requires, rpm -V, the setuid
# chrome-sandbox, the notices despite nodocs, ldd, a headless launch, and a clean dnf remove. See
# scripts/check-rpm-pkg.sh.
check-rpm-pkg:
    scripts/check-rpm-pkg.sh target/release/bundle/rpm/GitVolt-*.x86_64.rpm

# Runs the release binary from `just build-app`, with the installed sandbox helper if present.
run-app repo="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -e "{{sandbox_helper}}" ]; then export CHROME_DEVEL_SANDBOX="{{sandbox_helper}}"; rm -f target/release/chrome-sandbox; fi
    GITVOLT_OPEN="{{repo}}" target/release/gitvolt

# The app's icon set (crates/gitvolt-app/icons) from icons/source.svg, with the 32-64 px outputs from source-mid.svg and the 16 and 24 px
# layers from icons/source-small.svg (scripts/icons.py; needs the Tauri CLI and Pillow).
icons:
    python3 scripts/icons.py

# A desktop entry for the unbundled release build (H13): the dock and the app grid then show
# GitVolt's icon and match its window (StartupWMClass = the window's WM_CLASS, set in
# crates/gitvolt-app/src/desktop.rs). Writes only under $XDG_DATA_HOME (default
# ~/.local/share): applications/gitvolt.desktop and icons/hicolor/<size>/apps/gitvolt.png, plus
# the scalable source.svg. It launches this checkout's release binary (target/release/gitvolt,
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
    [ -x "{{justfile_directory()}}/target/release/gitvolt" ] || echo "note: target/release/gitvolt isn't built yet; run 'just build-app' before launching it from the dock." >&2
    data="${XDG_DATA_HOME:-$HOME/.local/share}"; apps="$data/applications"; icons="$data/icons/hicolor"
    mkdir -p "$apps"
    for size in {{desktop_icons}}; do
      dir="$icons/${size%%:*}/apps"; mkdir -p "$dir"
      cp "{{justfile_directory()}}/crates/gitvolt-app/icons/${size#*:}" "$dir/gitvolt.png"
    done
    mkdir -p "$icons/scalable/apps"
    cp "{{justfile_directory()}}/crates/gitvolt-app/icons/source.svg" "$icons/scalable/apps/gitvolt.svg"
    printf '%s\n' '[Desktop Entry]' 'Type=Application' 'Name=GitVolt' 'Comment=Git GUI' \
      'Exec="{{just_executable()}}" --justfile "{{justfile()}}" run-app' 'Icon=gitvolt' \
      'StartupWMClass=gitvolt' 'Categories=Development;RevisionControl;' 'Terminal=false' \
      > "$apps/gitvolt.desktop"
    command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true
    command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$icons" || true
    echo "Wrote $apps/gitvolt.desktop (Exec: just run-app in {{justfile_directory()}})"

uninstall-desktop:
    #!/usr/bin/env bash
    set -euo pipefail
    data="${XDG_DATA_HOME:-$HOME/.local/share}"; apps="$data/applications"; icons="$data/icons/hicolor"
    rm -f "$apps/gitvolt.desktop" "$icons/scalable/apps/gitvolt.svg"
    for size in {{desktop_icons}}; do rm -f "$icons/${size%%:*}/apps/gitvolt.png"; done
    [ -d "$apps" ] && command -v update-desktop-database >/dev/null && update-desktop-database "$apps" || true
    [ -d "$icons" ] && command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$icons" || true
    echo "Removed GitVolt's desktop entry and icons from $data"

lint:
    cargo clippy --workspace --all-targets -- -D warnings
    cd ui && npx tsc --noEmit
    cd site && npx tsc --noEmit

# A smoke check of the two §17.3 rows that need a live app (idle CPU, memory). Non-gating: it
# prints numbers next to the budgets and never fails on them. Point GITVOLT_PID at the browser
# process of a running instance (open the tabs you want measured first): the gitvolt process
# without `--type=` (not `pgrep -nx`, which finds a renderer; docs/dev-setup.md has a
# one-liner). The other rows are asserted by `just e2e`
# (menu-perf, tabs) and the opt-in real-repo spec. See docs/dev-setup.md.
bench:
    #!/usr/bin/env bash
    set -uo pipefail
    : "${GITVOLT_PID:?set GITVOLT_PID to a running GitVolt browser process (see docs/dev-setup.md)}"
    export GITVOLT_PID
    echo "== idle CPU, 60 s (budget < 1.5%; keep the window focused and idle) =="
    scripts/measure-idle.sh 60 || echo "(measure-idle failed)"
    echo
    echo "== memory (budget < 650 MB with 12 tabs open) =="
    scripts/measure-mem.sh || echo "(measure-mem failed)"
    echo
    echo "Budgets: idle CPU < 1.5%, memory (12 tabs) < 650 MB (spec §17.3). Informational only."
