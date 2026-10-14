# Contributing to GitVolt

Thanks for helping. This file covers how to build and test a change, the rules every change
follows, and how to report a bug. For how the code is organized, read
[ARCHITECTURE.md](ARCHITECTURE.md) first.

## Getting set up

Follow [docs/dev-setup.md](docs/dev-setup.md): the toolchain, the pinned Tauri CLI, the system
packages, and Chromium's sandbox helper, which unbundled builds need. Then install the UI's
dependencies once with `cd ui && npm ci`.

## Building, running and testing

| Command | What it does |
|---|---|
| `just dev [repo]` | Runs the app in development mode (the Vite dev server plus a debug build), optionally opening `repo` |
| `just playground` | Builds throwaway repositories to try the app on (Orbital, basic, sync, conflicts, …) in `~/gitvolt-playground`; more in [docs/playground.md](docs/playground.md) |
| `just test` | The Rust tests, the UI unit tests, the website demo's and the website's tests (needs the wasm toolchain, see [docs/dev-setup.md](docs/dev-setup.md)) and the packaging and release script tests |
| `just test-rust` | The Rust tests, with cargo-nextest when it's installed |
| `just test-ui` | All the UI unit tests (vitest) |
| `just test-ui-changed` | Only the vitest files related to what your branch changed: a quick check while you work |
| `just test-demo` | The website demo's tests: builds its wasm, then the parity suite and the demo smoke test |
| `just e2e-demo` | The Playwright smoke test of the demo build |
| `just demo-data` | Rebuilds the website demo's repositories into `site/demo-data` (a repo whose content didn't change keeps its bundle); see [docs/playground.md](docs/playground.md) |
| `just orbital-test [ref]` | Optional: builds Orbital, checks `ref` out and runs its own crates' tests (needs crates.io) |
| `just demo-build` | Builds the website demo into `site/dist/demo` |
| `just site-build` | Builds the website's landing page into `site/dist` and checks it (needs `cd site && npm ci` once) |
| `just site-dev` | Serves the website's page with the last demo build, at http://localhost:1430 |
| `just test-site` | The website's unit tests |
| `just e2e-site` | The website's Playwright checks |
| `just site-shots` | Retakes the website's screenshots from the demo build (on demand; commit the result) |
| `just site-pages` | Builds the website as GitHub Pages serves it into `site/dist` (the page, the demo, the 404 page) and checks it: links, no third-party requests, sizes; see [docs/website.md](docs/website.md) |
| `just e2e [args]` | The Playwright suite against the test harness; arguments go to Playwright (`just e2e e2e/diff.spec.ts`) |
| `just lint` | `cargo clippy --workspace --all-targets -- -D warnings` and `tsc --noEmit` |
| `just gen-types` | Regenerates the TypeScript types in `ui/src/api/gen/` and `ui/src/demo/gen/` from the Rust types |

With [cargo-nextest](https://nexte.st) installed, you can run part of the Rust suite:
`cargo nextest run -p gitvolt-core`, or one area of the harness's integration tests with
`cargo nextest run -p gitvolt-harness -E 'test(/^forge_stacks::/)'`.

**Fixture repositories are cached.** Each named fixture (`gitvolt_core::testing::fixtures`) is
built once into `target/fixture-cache/`, keyed on the `testing` module's source and the git
version, and every test (and `gitvolt-harness fixture`) gets a copy of it. Set
`GITVOLT_FIXTURE_CACHE=0` to build them fresh, for instance while you debug a fixture.

**Pick the cheapest test layer that proves the behavior.** A rule in the core gets a Rust unit
test; a component's logic or rendering gets a vitest test; a Playwright test is for a real flow
through the UI and the backend together. Each Playwright test boots the app, so it costs far more
than a unit test.

**vitest runs `.ts` tests in plain Node and `.tsx` tests in happy-dom.** Node starts several times
faster, so keep logic in `.ts` tests. A `.ts` test that needs a DOM (`document`, `localStorage`, a
store that touches them) says so on its first line: `// @vitest-environment happy-dom`. A test
that needs something only jsdom does says `// @vitest-environment jsdom` instead.

**Keep the e2e suite fast.** It runs on one worker, so every test adds to the total. Keep new specs lean: reuse an app boot where you can, and
move cases that don't need the whole stack down to vitest or Rust. Tests that assert a latency
budget are tagged `@budget`; they run last, in their own project.

If your change touches a type that crosses the Rust/TypeScript boundary, run `just gen-types` and
commit the regenerated files. Before you open a pull request, run `just lint` and `just test`,
plus the e2e specs for the areas you changed.

## Ground rules for tests

- **Fixtures are fictional.** Names, emails, hosts and project paths in tests are made up
  (`example.com` addresses, `gitlab.example.com`). Never use a real person, or a real host or
  repository.
- **Tests never touch the real keyring or a real forge.** Forge tests talk only to the harness's
  fake GitHub/GitLab, and tokens go in a token store inside a temporary directory, never the
  system Secret Service. Git in tests runs with the isolated environment from
  `gitvolt_core::testing`, never your own config, credentials or ssh agent.
- **Tokens never appear** in logs, error messages, the UI, test output, snapshots or committed
  fixtures. Use obviously fake tokens (`glpat-FAKE-…`, `ghp_FAKE-…`), or build real-looking ones at
  run time.
- **Secret scanning.** `.gitleaks.toml` holds the repository's [gitleaks](https://github.com/gitleaks/gitleaks)
  configuration: the default rules, plus an allowlist for known false positives. Run
  `gitleaks git` from the repository root before you push (it reads `.gitleaks.toml` from there).
  If it flags a test value that isn't a secret, change the value rather than widening the
  allowlist.

## Code style

- Match the code around you: its naming, structure and level of detail.
- Don't add comments that restate the code. A comment says why, or what isn't obvious.
- Rust must pass `cargo clippy --workspace --all-targets -- -D warnings`; TypeScript must pass
  `tsc --noEmit`. `just lint` runs both.
- Every write to a repository goes through the write pipeline (`run_write`, see
  [ARCHITECTURE.md](ARCHITECTURE.md#writes)). A new write method is listed in `WRITE_METHODS` in
  `crates/gitvolt-core/src/api.rs`; a new read gets a sample in the API test that checks reads
  never write.

## Commit messages

Look at `git log` for the style: a short summary line in sentence case, with no trailing period,
saying what the change does ("Move the WebKitGTK spike write-up to
docs/decisions/cef-over-webkitgtk.md"). An `area:` prefix is fine when it helps
("dev-setup: …"). Add a body when the reason for the change isn't obvious from the summary.

## Releasing

`just release <version>` prepares the release commit and tag, and pushing the tag builds the
packages into a draft GitHub release. [docs/releasing.md](docs/releasing.md) has the steps, the
version rules and the dry run.

## Licensing

GitVolt is MIT licensed (see [LICENSE](LICENSE)). By contributing, you agree that your
contribution is licensed under the same terms.

The packages ship the license notices of the third-party code they bundle (Rust crates, npm
packages, Chromium). When you add, remove or upgrade a dependency, regenerate the third-party
notices in the same change, and check the new dependency's license.

## Reporting bugs

Open an issue on GitHub with:
- what you did, what you expected, and what happened instead;
- your distribution and desktop, how you installed GitVolt (`.deb`, `.rpm`, Arch package, or built from
  source), and your git version;
- the diagnostics: Help → Debug…, then **Copy diagnostics**, and paste the text. It holds the
  GitVolt, Chromium, git and OS versions and your settings, with secrets removed;
- for a crash or an error, the relevant part of the log file. Logs are in
  `~/.cache/gitvolt/logs/` (under `$XDG_CACHE_HOME` if you set it); **Open logs folder** in the
  Debug dialog opens it. For more detail, turn on Settings › Advanced › Debug logging and
  reproduce the problem.

GitVolt keeps tokens out of its logs and diagnostics, but they can contain repository paths,
branch names and remote URLs. Read them before you post, and remove anything you don't want public.

Please report security issues privately, not as public issues.
