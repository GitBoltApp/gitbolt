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

dev repo="":
    cd crates/gitbolt-app && GITBOLT_OPEN="{{repo}}" cargo tauri dev

lint:
    cargo clippy --workspace --all-targets -- -D warnings
    cd ui && npx tsc --noEmit
