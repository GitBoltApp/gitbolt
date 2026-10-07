# Privacy

GitBolt has no accounts, servers or cloud service of its own. It talks only to your git remotes,
to the GitHub and GitLab accounts you add, and to Gravatar. This page lists every network request
the app makes, what each one sends, and how to turn it off. It also lists what GitBolt keeps on
your computer and how to delete it.

## Network requests

All requests come from the Rust core. In `crates/gitbolt-forge` they use the `ureq` HTTP client
(no cookies, `User-Agent: GitBolt/<version>`), and git remotes are reached by the `git` command
line. The UI makes no network requests of its own: every image it shows is handed over by the
core.

### Git remotes

**Background fetch.**

- When: while a repository's tab is shown, GitBolt runs
  `git fetch --all --prune --no-prune-tags --no-write-fetch-head`. It fetches once when the tab
  opens, if the last fetch is older than the interval, and then on every interval: every minute
  by default.
- It skips ticks while the window is minimized. Hidden tabs never fetch.
- It never prompts. A fetch that needs credentials is skipped.
- Sends: what `git fetch` sends to each of the repository's remotes, including any credentials
  that your git configuration, credential helper or ssh agent supplies.
- Turn off: Settings › Fetch › **Background fetch interval: Off**. "Prune deleted remote branches
  on fetch" chooses between `--prune` and `--no-prune`.

**Fetch, pull, push, clone and the rest.**

- When: only when you start one: Fetch, Pull, Push (including tags, deleting a remote branch and
  stack pushes), Clone, adding a remote, checking out an MR/PR from a fork, and a stack retarget.
- Sends: what the git command sends. A push uploads your commits.
- Turn off: don't start them.
- Reads never fetch from a remote. They run with `GIT_NO_LAZY_FETCH=1`, so a partial clone
  doesn't download missing objects while GitBolt reads it.
- Signature checks run your own `gpg` or `ssh-keygen` through git, with your configuration.
  GitBolt doesn't ask them to fetch keys, but a gpg set up to retrieve keys automatically will.

### Forge APIs (GitHub and GitLab)

GitBolt only calls a forge API for an account you add in Settings › Accounts. Without one, it
makes no forge requests (apart from images you choose to load, below).

- **Where:**
  - GitHub: `https://api.github.com`.
  - GitLab: `https://<your host>/api/v4`.
- **Sends:**
  - your token, in the `Authorization` header and only to that account's host;
  - the project paths of your repositories' remotes on that host, and branch names, to find
    their MRs/PRs;
  - what you ask for: MR/PR reads, comments, approvals, edits, new MRs/PRs, merges, retargets,
    and the people or labels you search for.
- **When:**
  - for the shown tab's repository, when the tab opens and after GitBolt writes something to the
    forge;
  - when the window gets the focus back, at most once every 10 seconds;
  - on the background fetch timer, never more often than once a minute, and only while the
    window has the focus. The timer runs faster while a visible MR/PR's pipeline is running.
  - Conditional requests (ETags) make an unchanged poll cheap, and GitBolt follows the forges'
    rate-limit and poll-interval headers.
- **Turn off:**
  - Remove the account (Settings › Accounts) to stop all requests to that forge.
  - Setting the background fetch interval to Off stops the timed polls. Polls when a tab opens or
    the window gets the focus still happen.

### Avatars

Avatars are looked up in this order: the forge that hosts the repository, then Gravatar, then, as
a last step, the repository's own forge project again. If none of these finds one, GitBolt shows
the author's initials. Results are cached on disk under the SHA-256 hash of the email: an avatar
that was found for 7 days, a "no avatar" for 1 day.

**From your forge accounts.** Setting: Settings › General › **Load avatars from your forge
accounts** (on by default).

- **Which forge:** a commit author's email or name goes only to the forge that hosts the
  repository you are viewing: an account whose host is the host of one of the repository's
  remotes. Your other forge accounts are never asked. A repository with no remote on a host where
  you have an account gets no forge lookup; Gravatar and initials are used instead.
- **GitLab:** GitBolt calls `GET /avatar?email=<the author's email>` on that GitLab account. The
  email is sent in plain text, with your token.
- **GitHub:** GitHub's noreply addresses are looked up on `avatars.githubusercontent.com` by the
  user id or login in the address, without the token. For any other email, when the repository's
  forge project is on GitHub, GitBolt asks
  `GET /repos/<owner>/<repo>/commits?author=<email>&per_page=1`. That sends the email to GitHub
  with your token. GitBolt then fetches the picture from the avatar host without the token. It
  skips this lookup when the rate-limit budget runs low.
- **By name:** if nothing else found an avatar, GitBolt may look the author's name up on the
  repository's forge account. On GitLab that is a user search (`GET /users?search=<name>`). On
  GitHub it uses only people GitBolt has already seen, so no request is made.
- **Pictures the forge links:** project owners and MR/PR participants. These are fetched from
  that forge's own hosts, or from Gravatar when the forge links there and the Gravatar setting is
  on. No email is sent for them.
- **Turn off:** uncheck the setting. GitBolt then makes no avatar request to your forges.

**From Gravatar.** Setting: Settings › General › **Load avatars from Gravatar** (on by default).

- GitBolt requests `https://gravatar.com/avatar/<SHA-256 of the trimmed, lowercased
  email>?s=80&d=404`. The email itself is never sent, and GitHub noreply addresses are never
  looked up.
- A hash isn't anonymous. Anyone who already knows an email can compute the same hash, and
  Gravatar sees your IP address with each request.
- After a network error, GitBolt makes no Gravatar request for 3 minutes.
- **Turn off:** uncheck the setting. GitBolt then makes no request to Gravatar, including for
  Gravatar links a forge returns.

### Images and videos in rendered Markdown

These are the images in MR/PR descriptions and comments, and in Markdown files and diffs. A video
(an image link to an `.mp4`, `.m4v`, `.mov`, `.webm` or `.ogv` file, which GitLab shows as a
video) follows the same rules, up to 100 MB, and is never cached on disk.

- **The forge's own hosts:** when the repository has a forge account, the core fetches the image
  automatically.
  - GitLab: images on your GitLab host, fetched with your token. Uploads are read through its
    API, or, on a GitLab older than 17.4 (which has no uploads API), from the upload's own
    address on the same host.
  - GitHub: images on `github.com`, `user-images.githubusercontent.com`,
    `private-user-images.githubusercontent.com`, `raw.githubusercontent.com` and
    `avatars.githubusercontent.com`. These are fetched without the token, which only ever goes to
    `api.github.com`.
- **Any other host:** nothing is fetched until you click **Load image from `<host>`** (or **Load video from**). The core
  then fetches that image over https, without any token. The choice lasts for that image until
  GitBolt restarts.
- **No request:**
  - relative images in a Markdown file are read from the repository;
  - inline `data:` images (PNG, GIF, JPEG, WebP) are shown as they are.
- Found images are cached on disk (see below).
- **Open with default app**, offered for a video the app can't play: the core fetches the video
  again, saves it in `~/.cache/gitbolt/open/` and opens it with your default video player.

### Links

Clicking a link (`http`, `https` or `mailto`) opens it in your default browser. GitBolt itself
makes no request for it.

### The embedded Chromium

The UI is GitBolt's own bundled files, served to the embedded Chromium through custom schemes; it
needs no network. Left alone, Chromium still contacts Google services by itself. In an idle run
of an unmodified build (two minutes, one repository open, background fetch Off, no forge
accounts) it fetched a spell-check dictionary (`redirector.gvt1.com`), checked for a Google
account (`accounts.google.com/ListAccounts`), asked whether "AI Mode" is available
(`www.google.com/async/folae`), queried the time (`clients2.google.com/time`) and downloaded a
Translate model (`www.gstatic.com`). GitBolt now turns all of that off
(`cef_runtime` in `crates/gitbolt-app/src/main.rs`):

- Chromium resolves no host name except `localhost` (`--host-resolver-rules`), so whatever it
  would fetch by itself fails inside Chromium before any DNS query or connection. It still
  tries the account check and the "AI Mode" check at startup, since no switch or preference
  stops them, but nothing leaves the machine. GitBolt's own network
  traffic (git, forge APIs, avatars and Markdown images) runs in the Rust core, which this
  doesn't affect.
- Off as well:
  - Chromium's component updater, background networking and Safe Browsing
    (`--disable-component-update`, `--disable-background-networking`, `safebrowsing.enabled`);
  - network time queries and the Translate ranker (Chromium features
    `NetworkTimeServiceQuerying`, `TranslateRankerQuery`, `TranslateRankerEnforcement`);
  - preconnects and DNS prefetching (`net.network_prediction_options`);
  - the Chrome profile features that call Google services: the password manager and its leak
    detection, autofill, Translate, alternate error pages, search suggestions, and the Privacy
    Sandbox APIs (`vendor/tauri-runtime-cef/src/cef_impl/preferences.rs`).
- **Spell check works offline.** GitBolt ships Chromium's English (US) dictionary
  (`/usr/share/GitBolt/dictionaries/en-US-10-1.bdic`) and copies it into Chromium's profile at
  startup, so Chromium never downloads one. Only English (US) is checked
  (`spellcheck.dictionaries`). Chromium's "enhanced" spell check, which sends the text to
  Google's spelling service, is off (`spellcheck.use_spelling_service`) and removed from the
  right-click menu, along with "Language settings".
- **Measured:** the same idle run of a release build, with Chromium's network log on and
  GitBolt's sockets sampled every half second for two minutes, showed no DNS query and no
  connection from Chromium (apart from its IPv6 reachability probe, a UDP `connect()` that sends
  no packet). The only other request was the core's Gravatar lookup for the
  repository's commit author, which the Gravatar setting allows. With the bundled dictionary, a
  run of about two minutes that also typed misspelled words into the commit message (which
  Chromium underlined) showed no request for a dictionary in the network log, and no socket
  but the measurement's own local debugging port. If you see Chromium make a
  request, please open an issue.

### What isn't there

GitBolt has no telemetry, analytics, crash reporting or update checks.

- The Rust code has no HTTP client besides the forge and Gravatar code above.
- The UI code makes no requests of its own. Its WebSocket client is used only by the test
  harness, outside the app.
- The packages ship no `crash_reporter.cfg`, the file CEF needs before it will upload crash
  reports.
- Crashes and errors go only to the local log files.

## Data on your computer

Paths are the XDG defaults. `$XDG_CONFIG_HOME`, `$XDG_CACHE_HOME` and `$XDG_DATA_HOME` move them.

| Where | What |
|---|---|
| `~/.config/gitbolt/settings.json` | App settings and the window's last position. |
| `~/.config/gitbolt/profiles/<id>/profile.json` | Each profile: open tabs and recent repositories (their paths), repository folders, editor choice, extra git config path, per-repository settings, and the forge accounts (host, user name, where the token is kept, never the token). |
| System keyring, items with `service` = `gitbolt` | Forge tokens, one per profile and host. |
| `~/.local/share/gitbolt/forge-tokens` | Forge tokens, only when no keyring was available. |
| `~/.local/share/gitbolt/forge-cache/` | The last MR/PR lists and project data per account, so a restart shows them at once. Removing an account deletes its host's folder. |
| `~/.local/share/gitbolt/journal/`, `rewrites/`, `tmp/` | The undo journal per worktree, the notes Push uses after a rewrite, and temporary index files. |
| `~/.cache/gitbolt/logs/` | Log files: daily, the newest 7 kept, at most 50 MB in all, redacted. They contain repository paths, git commands and error messages. |
| `~/.cache/gitbolt/avatars/`, `forge-avatars/` | Avatar and Markdown image caches, named by SHA-256 hashes. |
| `~/.cache/gitbolt/open/` | Old file versions written for "Open in…", and videos opened with the default app. Copies older than a week are removed at startup. |
| `~/.cache/dev.gitbolt.desktop/cef/` | Chromium's profile for the UI: its local storage (UI preferences, and unsent commit-message and MR/PR drafts), the words you add to the spell-check dictionary, a copy of the bundled dictionary (`Dictionaries/`) and `cef.log`. |
| `$XDG_RUNTIME_DIR/gitbolt-*` | The askpass and single-instance sockets. Removed when GitBolt exits. |
| Inside your repositories | Undo snapshots are stored as unreferenced commits in the repository's object store. `git gc` removes them in time. |

### Deleting it all

1. Remove each forge account in Settings › Accounts, and revoke its token on the forge. GitBolt
   doesn't revoke tokens.
2. Quit GitBolt, then run:

   ```sh
   rm -rf ~/.config/gitbolt ~/.cache/gitbolt ~/.local/share/gitbolt ~/.cache/dev.gitbolt.desktop
   secret-tool clear service gitbolt
   ```

   `secret-tool` comes with libsecret, packaged as `libsecret-tools` on Debian and Ubuntu.
