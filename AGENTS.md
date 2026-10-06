# Notes for AI coding agents

GitBolt is a desktop Git client: a Rust core (`crates/`), a React UI (`ui/`), and Tauri on the
Chromium (CEF) runtime. Read these before changing anything substantial:

- [ARCHITECTURE.md](ARCHITECTURE.md): how the pieces fit, and where things live.
- [CONTRIBUTING.md](CONTRIBUTING.md): building, testing, test ground rules, commit style.
- [docs/dev-setup.md](docs/dev-setup.md): machine setup, including the Chromium sandbox helper.
- [SECURITY.md](SECURITY.md) and [PRIVACY.md](PRIVACY.md): the guarantees your change must keep.
- [docs/licensing.md](docs/licensing.md) and [docs/releasing.md](docs/releasing.md) when you
  touch dependencies or packaging.

## Working rules

- **Match the surrounding code.** Its naming, idioms and comment density. Keep comments for the
  non-obvious "why".
- **Prove it with the cheapest test layer.** Unit tests (vitest, nextest) first. Add an e2e test
  only when nothing else can show the behaviour, and fit it into an existing spec as a
  `test.step` rather than a new page load, so the suite stays fast.
- **Run the narrow checks while iterating, the full ones before you finish:**
  - `just test-ui-changed`, `cargo nextest run -p <crate>`;
  - then `just test`, `cargo clippy --workspace --all-targets -- -D warnings`, and
    `cd ui && npx tsc --noEmit`.
- **Changed a Rust type the UI uses?** Run `just gen-types` and commit the regenerated
  `ui/src/api/gen/` files.
- **Leave `CARGO_INCREMENTAL` unset.** Setting it to `1` breaks sccache, and `0` makes rebuilds
  slow. The harness's integration tests are one binary, `crates/gitbolt-harness/tests/it/`.
- **Running e2e from parallel worktrees?** Give each one its own `GITBOLT_E2E_PORT_BASE`.

## Things that will bite you

- **Fixtures are fictional:** no real people, emails, hosts, repos or MR numbers.
- **Tests never use the real keyring or a real forge;** use the harness's fake forge.
- **Tokens never appear** in logs, errors, UI, test output or fixtures.
- **Writes go through the `git` CLI** (hooks, config and credentials must behave as in a
  terminal). Never pass `-c user.*` or otherwise override the user's git identity.
- **The webview is locked down:**
  - a strict Content Security Policy (`crates/gitbolt-app/tauri.conf.json`);
  - Chromium can't resolve any host name except localhost.

  Anything that needs the network goes through the Rust core, and a new remote resource needs
  an explicit exception and a PRIVACY.md update.
- **Dependencies are license-checked at build time** (`just licenses`). A new dependency must be
  under an allowed license; copyleft is refused.
- **Stage files explicitly** (`git add <paths>`), never `git add -A`.
- **Keep main's history linear.** Squash-merge a branch or round of work into main as one commit
  with a summary message (`git merge --squash`); no merge commits.

## UI conventions

- **Destructive or irreversible actions arm in place:** the first click arms the control (its
  label says what the second click does, in red if destructive), the second click runs it, and
  clicking elsewhere or Esc cancels. No timers, and no modal dialogs.
- **Popovers are for real choices only,** or for actions started from the keyboard.
- **No layout shift:** loading and armed states reserve or overlay their own space.
- **Every action is reachable by keyboard.** New shortcuts go in the shortcuts registry, so the
  Keyboard Shortcuts panel lists them.
