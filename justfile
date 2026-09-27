set shell := ["bash", "-cu"]

default: test

test: test-rust test-ui

test-rust:
    cargo test --workspace

test-ui:
    cd ui && npx vitest run --passWithNoTests

gen-types:
    cargo test -p gitbolt-core export_bindings

e2e:
    cargo build -p gitbolt-harness
    cd ui && npx playwright test

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

# Runs the release binary from `just build-app`, with the installed sandbox helper if present.
run-app repo="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -e "{{sandbox_helper}}" ]; then export CHROME_DEVEL_SANDBOX="{{sandbox_helper}}"; rm -f target/release/chrome-sandbox; fi
    GITBOLT_OPEN="{{repo}}" target/release/gitbolt

lint:
    cargo clippy --workspace --all-targets -- -D warnings
    cd ui && npx tsc --noEmit
