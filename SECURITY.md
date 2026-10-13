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

- The UI runs in Chromium's multi-process sandbox. GitBolt asks the CEF runtime for
  `SandboxPolicy::Required` (`crates/gitbolt-app/src/lib.rs`): if Chromium can't sandbox its
  processes, GitBolt refuses to start instead of running unsandboxed.
- On Windows, Chromium sandboxes only when GitBolt runs as a DLL under CEF's `bootstrap.exe`,
  which makes the sandbox broker (`RunWinMain` in `crates/gitbolt-app/src/lib.rs`,
  `vendor/tauri-runtime-cef/GITBOLT-PATCH.md`). The installers ship exactly that: `GitBolt.exe`
  is the bootstrap, from the same CEF build as the one linked, and `GitBolt.dll` the app
  (`scripts/package-windows.ps1` checks the versions match). A release build without the broker
  refuses to start. A debug build stays on `Auto`: a plain `gitbolt.exe`, as `cargo build` makes
  it, runs unsandboxed and logs a warning.
- On macOS, the helper apps in `GitBolt.app/Contents/Frameworks` enter Chromium's Seatbelt
  sandbox through the framework's `libcef_sandbox.dylib` before they load the framework itself.
  This works with the bundle ad-hoc signed (no Apple identity). GitBolt only runs from its
  bundle there, which always ships the library: a helper without it fails to start rather than
  run unsandboxed.
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
- A file's front matter is parsed as plain data (YAML's core schema: no custom tags, a capped
  alias expansion; or TOML), and its values render as text, never as Markdown or HTML. A block
  that doesn't parse shows as a code block.
- Issue references, the front matter table, and the marks a rendered diff adds, carry a random nonce made for each
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
  single IPC command (`crates/gitbolt-app/src/lib.rs`), so a script that ran in the page would
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
  - `media-src 'self' blob:`: a video in rendered Markdown plays from a `blob:` URL of the bytes
    the core fetched, and audio and video in the diff and File View from a `blob:` URL of the
    file's bytes;
  - no `font-src` (so `default-src 'self'`): a font file in the diff and File View is previewed
    from its bytes (a `FontFace` built from a buffer, never fetched from a URL), which pass
    through Chromium's font sanitizer (OTS) like any web font;
  - `connect-src 'self' ipc: http://ipc.localhost`: the app's own IPC only;
  - `object-src 'none'`, `base-uri 'none'`, `frame-ancestors 'none'`, `form-action 'none'`.
- **The page may read the clipboard's text** (the clipboard plugin's `read-text` permission,
  `crates/gitbolt-app/capabilities/default.json`), for Ctrl+V's "Go to what's on the
  clipboard"; the UI reads it only then. It goes through the plugin because Chromium's own
  `navigator.clipboard.readText()` asks for a permission in the app, and that prompt never
  answers. Like the rest of the IPC, it is reachable only by the bundle's own scripts (the CSP above).
- The end-to-end tests run the UI under the same policy (sent by `vite preview`,
  `ui/vite.config.ts`), and fail on any violation (`ui/e2e/test.ts`). `ui/e2e/csp.spec.ts` checks
  that a script injected into rendered Markdown never runs.

### Rendered HTML files

An `.html`, `.htm` or `.xhtml` file shows rendered in File View and Diff View
(`ui/src/diff/pageDoc.ts`, `HtmlPage.tsx`). Its markup is untrusted. Two layers keep it from
running, and these are the guarantee:

- **The sandbox.** It shows in an `<iframe sandbox>` with no permissions: no scripts, an opaque
  origin (no access to the app or its IPC), no forms, popups or navigation of the app. Its
  content comes through `srcdoc`.
- **The Content Security Policy.** A `srcdoc` document inherits the app's policy, and GitBolt
  adds a stricter one first in its head: `default-src 'none'`, with only inline styles and
  `data:` images, fonts and media. Nothing is fetched, from the network or from the app's own
  origin.

On top of these, best-effort hardening, which the guarantee doesn't rely on:

- `<script>` elements, `on…` handlers, `javascript:` URLs, `<link>`s that weren't inlined,
  `ping` and `attributionsrc`, `<base>`, `<meta http-equiv="refresh">` and nested `srcdoc` are
  taken out before it shows, and every link
  opens a new window, which the sandbox refuses: a click does nothing.
- Relative images and stylesheets are read from the repository (at the commit shown) and inlined
  as `data:` URLs and `<style>` before that clean-up, with `</style` escaped in the CSS. The
  result is parsed and cleaned again until it doesn't change, so markup that reads differently
  once parsed again (SVG or MathML namespace confusion) is cleaned as the frame will read it.
- Scripts and files on other hosts don't load; a bar names those hosts, and **Open in browser**
  opens the file outside the app, through the system's Open With chooser.

### PDFs

A PDF in File View or Diff View is untrusted bytes from the repository, drawn by pdf.js
(`pdfjs-dist`, `ui/src/pdf/pdfjs.ts`), not by Chromium's PDF viewer:

- It is parsed in pdf.js's own Web Worker; the page only draws what the worker sends (canvases,
  and a text layer of plain text nodes for selection).
- No annotation layer, forms, XFA or PDF JavaScript: links and scripts in the document are never
  rendered or run. Annotations' appearances (stamps, filled-in fields) are drawn on the canvas, as
  pixels only. pdf.js 6 has no `eval` path at all, and its worker runs under the app's policy
  like the others, which would block one.
- It needs no change to the CSP: the worker and the JPEG 2000 and JBIG2 decoders' WebAssembly
  are the bundle's own files (`'self'`, `'wasm-unsafe-eval'`). Chromium's built-in viewer would
  need `object-src` and `frame-src` opened to `blob:`, and runs PDFium in a frame of the page.
- Keep `pdfjs-dist` current: a parser bug that ran code here would run it with the UI's powers
  (CVE-2024-4367 was one, fixed in pdf.js 4.2.67).

### Git hooks and repository config

GitBolt runs `git` the way you would in a terminal, so a repository's hooks and config apply.
That is a trust boundary.

- **Writes run hooks.** A commit runs `pre-commit`, `commit-msg` and the other commit hooks.
  Merge, rebase, checkout and push run theirs. GitBolt has no option to skip them.
- **Submodules: Update runs hooks inside the submodules.** `git submodule update` checks out each
  submodule, which runs that submodule's own `post-checkout` hook and reads its own config, and it
  clones from the URLs in `.gitmodules`, which the repository chooses. Update only repositories
  whose submodules you trust, as in a terminal.
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

### Open in default app

**Open in default app** (**Open in browser** for an HTML file) hands a file to the program your
system opens it with. GitBolt never uses it to run a repository's file. Before anything starts,
the core refuses a file the system would execute or launch rather than open:

- by its extension, on every OS: executables, scripts, installers and shortcuts (`.exe`, `.bat`,
  `.cmd`, `.ps1`, `.msi`, `.lnk`, `.url`, `.jar` and the like), and the launchers and scripts a
  Linux desktop or macOS may run (`.desktop`, `.sh`, `.command`, `.app`, `.AppImage`, `.webloc`,
  `.scpt` and the like);
- on Linux and macOS, a file with any execute permission;
- on Windows, a type the shell itself calls dangerous (`AssocIsDangerous`).

It checks both the name the file has in the repository and the file it resolves to, so a
symlink to an executable is refused too. An old version opens as a read-only copy (or as the
working-tree file, when that has the same bytes), checked by the name it's shown under. The menu shows the entry disabled for such a file, and
**Other…** or an editor still opens it.

### Updates

GitBolt can download and install its own updates from GitHub Releases
(`crates/gitbolt-core/src/updates/`, `crates/gitbolt-forge/src/updates.rs`).

- **Checksums.** A downloaded package is kept only if the same release's `SHA256SUMS` lists it
  with the same SHA-256 digest. A mismatch, a package `SHA256SUMS` doesn't list, or a release
  without `SHA256SUMS` deletes the download and says so; it is never run. Right before the
  install, the digest is checked again, so a file changed in the meantime is deleted too.
- **Where downloads come from.** The release list comes from `api.github.com` without any
  token. A package is fetched only from `github.com/GitBoltApp/gitbolt/releases/download/`, and
  a redirect is followed only to GitHub's asset storage (`objects.githubusercontent.com`,
  `release-assets.githubusercontent.com`), over https, through the same HTTP client (TLS, proxy,
  timeouts) as the forge API. The download goes to `~/.cache/gitbolt/updates/` (0700; `%LOCALAPPDATA%\gitbolt\updates` on Windows, `~/Library/Caches/GitBolt/updates` on macOS).
- **What `SHA256SUMS` proves.** It catches a corrupted or swapped download, but it comes from the
  same release, so it only proves the file is the one published there. **The packages aren't
  code-signed yet.** For a stronger check, GitHub's build provenance attestations tie each
  package to the release workflow that built it; verify one by hand with the GitHub CLI:

  ```sh
  gh attestation verify GitBolt_0.3.0_amd64.deb --repo GitBoltApp/gitbolt
  ```

- **The install.** GitBolt runs `pkexec apt install -y ./<package>.deb` or
  `pkexec pacman -U --noconfirm <package>` as an argument list (no shell), so your desktop's
  polkit prompt asks for the password; GitBolt never sees it and never uses `sudo` itself. If
  `pkexec` is missing or you cancel, it shows the `sudo` command to run yourself. On Windows it
  starts the installer (the NSIS setup, or `msiexec /i` for the MSI) and quits. On macOS it runs a
  fixed script as you (`/bin/sh -c`, the two paths as arguments, never spliced into it): it mounts
  the `.dmg` read-only and unbrowsed, copies its GitBolt.app with `ditto` beside the running one
  and swaps them by rename, never asking for an administrator password; where the app's folder
  isn't writable it shows the manual steps instead. GitBolt's downloads carry no quarantine flag
  (it isn't App Sandboxed and doesn't set `LSFileQuarantineEnabled`), so Gatekeeper doesn't check
  the copy again: `SHA256SUMS` is the check, as on the other platforms.
- **Which package.** Each package names how it was installed in an `install-kind` file beside the
  binary (`deb`, `arch`, `nsis` or `msi`), or in the bundle's `Contents/Resources` (`dmg`); a build
  from source has none and is only offered the release page.

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
  `crates/gitbolt-app/src/lib.rs`). Debug workspace builds, used for tests and lints, are
  unaffected.
- The UI's test hooks (`window.__gb` and the minimized-window override) are compiled only into
  development and e2e builds. The WebSocket transport is used only when the page isn't running
  inside the app.
