# Security

## Supported versions

GitBolt is alpha software. Only the latest build gets security fixes.

## Reporting a vulnerability

Please report vulnerabilities privately through GitHub's private vulnerability reporting on
this repository (**Security › Report a vulnerability** on `GitBoltApp/gitbolt`). Don't open a
public issue for a security problem.

A useful report says which build you ran, what an attacker needs (a crafted repository, a
remote, a forge account, local access…), and the steps to reproduce it.

## Security model

GitBolt is a desktop app: a Rust core that runs `git` and talks to forges, and a React UI in an
embedded Chromium (CEF). It has no server and no accounts of its own. What follows describes the
current code; each point names where to look.

### Chromium sandbox

- The UI runs in Chromium's multi-process sandbox. On Linux GitBolt asks the CEF runtime for
  `SandboxPolicy::Required` (`crates/gitbolt-app/src/main.rs`): if Chromium can't sandbox its
  processes, GitBolt refuses to start instead of running unsandboxed.
- The `.deb` and Arch packages ship Chromium's `chrome-sandbox` helper owned by root with the
  setuid bit (mode 4755). The packaging checks fail the build otherwise (`scripts/check-deb.sh`,
  `scripts/package-arch.sh`). For development builds, see [docs/dev-setup.md](docs/dev-setup.md).
- Release builds ignore Chromium switches given on the command line, so the installed binary
  can't be started with `--remote-debugging-port` or `--disable-web-security`. DevTools are off
  in release builds (`vendor/tauri-runtime-cef`).

### Forge tokens

- GitHub and GitLab personal access tokens are kept in the system keyring, through the Secret
  Service D-Bus API (GNOME Keyring, KWallet, KeePassXC…) via the `keyring` crate
  (`crates/gitbolt-forge/src/tokens.rs`). Each is an item in the default collection with the
  attributes `service` = `gitbolt` and `username` = `<profile id>/<host>`.
- When no Secret Service is available, or it refuses the token, the token goes to a fallback
  file, `~/.local/share/gitbolt/forge-tokens`: mode 0600 in a 0700 directory you own, written
  through a temporary file and a rename, never through a symbolic link. Settings › Accounts marks
  such an account "File — not secure". Once a keyring is available, GitBolt moves the token there
  the first time it uses the account after a restart, then deletes the file copy.
- Tokens never go into the settings or profile files: a profile records the host, the user and
  where the token is, not the token.
- A token is sent only in the `Authorization` header, and only to its own account's host. API
  requests follow no redirects. An image redirect is re-checked, and the token never goes to
  another origin (`crates/gitbolt-forge/src/http.rs`).
- In memory a token is a `Secret` type that never prints or serializes its value. As a second
  line of defence, every log line, git error and message shown in the UI passes through a
  redaction filter (`crates/gitbolt-core/src/redact.rs`). The filter removes URL credentials,
  token query parameters, `Authorization` headers and known GitHub and GitLab token formats.
- Removing an account (Settings › Accounts) deletes its token from the keyring and from the
  fallback file. It doesn't revoke the token on the forge.

### Credential prompts

- `git` and `ssh` run the GitBolt binary itself as `GIT_ASKPASS` / `SSH_ASKPASS`
  (`crates/gitbolt-core/src/askpass.rs`). It forwards the prompt to the running app over a Unix
  socket created for this session in `$XDG_RUNTIME_DIR`, or in a private 0700 folder in the temp
  directory when that variable isn't set. The socket is mode 0600 and only accepts a peer with
  your user id (`SO_PEERCRED`). Each request must also carry a random 128-bit session token,
  which is compared in constant time.
- Only a network operation that you started can show a prompt. GitBolt's own background fetch
  is denied at once and never prompts. It also sets `GCM_INTERACTIVE=never`, so Git Credential
  Manager doesn't prompt either.
- Every git command runs with `GIT_TERMINAL_PROMPT=0`. Network commands run in a new session
  with no controlling terminal, so nothing can prompt on the terminal GitBolt was started from.
- `ssh` gets `SSH_ASKPASS_REQUIRE=force`: passphrase, PIN and host key questions all come to
  GitBolt's dialog.
- GitBolt doesn't keep your answers. A git credential helper you configured may keep them, as it
  would in a terminal.
- Network commands also run with `-c protocol.ext.allow=never`, which disables git's `ext::`
  transport.

### Rendered Markdown

MR/PR descriptions and comments, and Markdown files in File View and Diff View, are rendered from
untrusted text (`ui/src/markdown/`).

- Raw HTML is parsed, then sanitized with `rehype-sanitize`, using GitHub's schema with these
  changes (`sanitize.ts`):
  - `script`, `style`, `iframe`, `object`, `embed`, `svg`, `math`, `noscript`, `template`,
    `textarea`, `select` and `title` are removed along with their contents;
  - no `class` attribute, except `language-*` on code, and no `style`, `tabindex`, `accesskey` or
    form attributes;
  - `id` and `name` get a `user-content-` prefix;
  - links may only be `http`, `https`, `mailto` or relative. `data:` images are allowed only as
    base64 PNG, GIF, JPEG or WebP.
- Issue references, and the marks a rendered diff adds, carry a random nonce made for each
  render. A value the document writes itself doesn't match the nonce and is dropped, so a
  document can't forge them (`render.tsx`).
- Links are rendered without an `href`, so the webview never navigates. A click goes through the
  core, which opens only `http`, `https` and `mailto` links in your default browser
  (`crates/gitbolt-core/src/links.rs`).
- The webview never loads a remote image: every `<img>` shows a `data:` or `blob:` URL. The core
  fetches the bytes. Images on the forge's own hosts load automatically. Images on any other host
  wait until you click "Load image from `<host>`", and are then fetched over https without any
  token. See [PRIVACY.md](PRIVACY.md).
- Mermaid diagrams render with `securityLevel: 'strict'` and are shown as an SVG image, in which
  scripts don't run.
- **A Content Security Policy is the second layer.** The UI reaches the Rust core through a
  single IPC command (`crates/gitbolt-app/src/main.rs`), so a script that ran in the page would
  have the UI's full powers. The policy (`app.security.csp` in `crates/gitbolt-app/tauri.conf.json`)
  keeps one from running even if it got past the sanitizer:
  - `default-src 'self'`: nothing loads from outside the app's bundle;
  - `script-src 'self' 'wasm-unsafe-eval'`: only the bundle's scripts run, plus WebAssembly for
    the syntax highlighter (Shiki's Oniguruma engine). No `unsafe-eval`, no `unsafe-inline`:
    an inline `<script>` or an `onerror=` attribute is blocked. Tauri adds
    the hashes of the bundle's own inline scripts (the first-paint theme script in
    `ui/index.html`, and one per bundled script file);
  - `style-src 'self' 'unsafe-inline'`: the editor (Monaco) and the UI set inline styles. This
    is the policy's one loose part: injected CSS could restyle the page, but can't run code or
    load anything from outside;
  - `img-src 'self' data: blob:`: the core hands over every remote image as `data:` or `blob:`;
  - `connect-src 'self' ipc: http://ipc.localhost`: the app's own IPC only;
  - `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'none'`.
- The end-to-end tests run the UI under the same policy (sent by `vite preview`,
  `ui/vite.config.ts`), and fail on any violation (`ui/e2e/test.ts`). `ui/e2e/csp.spec.ts` checks
  that a script injected into rendered Markdown never runs.

### Git hooks and repository config

GitBolt runs `git` the way you would in a terminal, so a repository's hooks and config apply.
That is a trust boundary.

- **Writes run hooks.** A commit runs `pre-commit`, `commit-msg` and the other commit hooks.
  Merge, rebase, checkout and push run theirs. GitBolt has no option to skip them.
- **Opening a repository runs no commit hooks, but it does run git in it.** What runs:
  - Read commands: `git worktree list` and `git status` as soon as the tab opens, then, as you
    browse, `git log`, `git diff`, `git show`, `git blame` and the like. git reads the repository's own `.git/config` for each of them, so a command it
    names can run: `core.fsmonitor` runs on `git status`, as it does in a terminal and in every
    git client.
  - A background fetch, unless it's Off (Settings › Fetch › **Background fetch interval: Off**).
    When the tab opens, GitBolt runs `git fetch --all` at once if the last fetch is older than the
    interval (always, the first time), then once per interval. `git fetch` runs the
    `reference-transaction` hook when it updates refs, and then git's auto maintenance
    (`git maintenance run --auto`), which can run `pre-auto-gc`.
  - Diffs run with `--no-ext-diff --no-textconv`, so external diff and textconv drivers don't
    run.
- **Ownership.** git's `safe.directory` check applies unchanged: a repository owned by another
  user doesn't open ("detected dubious ownership"), unless your own git configuration lists it in
  `safe.directory`. GitBolt never sets `safe.directory` itself, and its own reads (through `gix`)
  open such a repository with reduced trust only until git refuses it.
- To open a repository you don't trust without running its fetch hooks, set the background fetch
  interval to Off first. `git status` and the other reads still run, so its `core.fsmonitor` still
  applies: open it only if you'd also run `git status` in it.

### Test-only code

- The end-to-end test harness (`crates/gitbolt-harness`) is a separate binary. It serves the API
  over a WebSocket on `127.0.0.1`, with `/test/*` routes. It accepts WebSocket upgrades only from
  `localhost`, `127.0.0.1` or `tauri://` origins, and refuses writes outside fixture
  repositories. The packages don't include it: they contain only the `gitbolt` binary and CEF's
  files.
- Test-only API requests are compiled only with `gitbolt-core`'s `testing` feature, and only the
  harness turns it on. The packaged app is built from `crates/gitbolt-app` alone, which doesn't.
  A `cargo build --workspace` would unify the feature into `gitbolt-app` as well, so a release
  build of `gitbolt-app` with it on fails to compile (a constant assertion in
  `crates/gitbolt-app/src/main.rs`). Debug workspace builds, used for tests and lints, are
  unaffected.
- The UI's test hooks (`window.__gb` and the minimized-window override) are compiled only into
  development and e2e builds. The WebSocket transport is used only when the page isn't running
  inside the app.
