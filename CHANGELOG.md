# Changelog

All notable changes to GitBolt are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Changed

- **New app icon:** two graph lanes, one cool and one warm, branch from a commit and merge into
  another, outlining a bolt. Its commits are drawn as the graph draws them: a ring in the lane's
  colour. Small sizes use a bolder version of the same mark.

### Fixed

- A signed commit's status card wraps git's message (such as an unknown key's), and the pointer
  can move into it to read or copy the text; the message scrolled sideways in a card that closed
  on the way to the scrollbar.
- The hex view's right-hand bar scrolls like the other diffs' overview ruler: a click jumps there
  and keeps dragging, the slider drags from the point grabbed, and the wheel scrolls.
- Compare with working tree against an older commit lists binary files (images and the like)
  changed in a later commit; they were dropped as unchanged.
- A submodule with uncommitted changes inside, still at its recorded commit, no longer offers a
  hunk to stage in the working-copy diff; it is refused like any submodule change.
- A narrow details panel's file toolbar (Collapse all, Path/Tree, View all files) no longer
  overlaps itself: at the panel's narrowest its buttons show as icons, named by their tooltips.
- A working-copy diff's toolbar shows its staging Undo and Redo again. They were drawn midway down
  the diff's right edge instead, under the scroll strip, where they showed as a stray arrow and
  couldn't be clicked.

## [0.6.0] - 2026-10-12

### Added

- **Audio, video and font previews** in the diff and File View, in place of a hex dump: a player
  for each side (old and new side by side, as images are), and for a font its name, a pangram at
  a few sizes and its Basic Latin glyphs. A format the app can't play says so, with Open in and
  the hex view; the **Hex** toggle shows the bytes any time.
- **PDFs show as pages** instead of a hex dump: File View shows the file's pages, with selectable
  text; Diff View shows the old and new versions side by side, scrolled in step, page beside page.
  Fit width or zoom (the slider, Ctrl+wheel); **Hex** still shows the bytes. A PDF over 2 MB asks
  before it loads, as a large image does.
- **CSV and TSV files as a table.** File View shows a `.csv` or `.tsv` file as a table, its
  header row and row numbers staying in view as you scroll, numbers right-aligned; Diff View lines
  the rows up, added rows green, removed red, a changed row's cells marked. **Source | Table** (or
  Mod+Shift+V) switches, remembered apart from Markdown's. A very large file shows its source.
- **Rendered HTML files.** An `.html`, `.htm` or `.xhtml` file gets a **Source | Rendered**
  toggle in File View and Diff View (its own pick, Source by default). Rendered shows the page as
  a static preview in a sandbox: its scripts don't run and nothing is fetched, with its relative
  images and stylesheets read from the repository. A diff shows the old and new pages side by
  side. When a page uses scripts or files from other hosts, a bar names them, with **Open in
  browser**.
- **Submodules**, in repositories that use them: a submodule's row in the changes says
  "submodule: new commits" (or "modified content" when that's all, or "not initialised"), and its
  diff names each commit's subject. Staged, it's one row on the staged side: edits left inside it
  are committed in the submodule, not split into an unstaged row.
  From the command palette, **Submodules: Update** (Mod+Alt+B; it asks before leaving commits on
  no branch behind), **Submodules: Sync URLs** and **Submodules: Open in a tab…** (Mod+Alt+O); a
  submodule row's menu has Open in a tab and Update this submodule. Each says the git command it
  ran.
- **Git LFS**, in repositories that use it: diffs, File View, image diffs and File History show
  an LFS file's real contents from the local LFS store, never its pointer. One that isn't
  downloaded says so, with its size, **Download** and **Show pointer**. File lists mark LFS files;
  the palette has **LFS: Pull** and **LFS: Fetch**; a file's menu has **Track \*.ext with LFS**
  and **Stop tracking \*.ext** (undoable). Without git-lfs installed, the status bar says so.

- **Apply a suggested change** to your working copy: a review comment's suggestion, in the diff's
  cards or on the MR timeline, has **Apply** when the MR's branch is checked out at its head and
  the lines it replaces are unchanged. It edits the file (no commit, nothing sent to the forge),
  and Undo takes it back. Otherwise Apply says why it can't: another branch or commit, the lines
  changed since, a comment on an older version, or already applied.
- **Open in default app** in a file's **Open in** menus: the file in the app your system opens it
  with, or **Open in browser** for an HTML file. A commit's version opens as the file itself when
  it hasn't changed since (an HTML page's stylesheets and images load), and as a temporary
  read-only copy when it has. A file the system would run as a program is never opened this way.
- **A note when committing to main in your fork.** Above Commit: changes for a pull request
  usually go on their own branch. **Create branch…** makes one at HEAD, carrying what's staged;
  **Dismiss** hides the note for that repository.
- **Go to the clipboard.** Press Ctrl+V (Cmd+V) outside a text field to go to what's on the clipboard: a
  commit hash selects the commit (in another open tab if it's there); an MR or PR link, `!12` or
  `#12` opens its view; a forge's commit or file link, or a file path with `:12` or `#L12-20`,
  opens it at those lines with the file selected; a branch or tag name selects its tip.
- **`.rpm` package** for Fedora 40 or later and openSUSE Tumbleweed, beside the `.deb` and the Arch package:
  `sudo dnf install ./GitBolt-<version>-1.x86_64.rpm`. It's the `.deb`'s files (the setuid
  `chrome-sandbox`, icons, desktop entry, license notices) with Requires in rpm's own form, so
  dnf and zypper fetch what it needs. GitBolt updates it itself, through dnf (zypper on openSUSE)
  and your password prompt, as it does the `.deb`.
- **Your repos filter and sort** on the Open screen: a filter box (by name or path) and a toggle
  between most recently changed first and A–Z, and one between one list and a list under each
  directory, both remembered. With more than one directory scanned,
  each repository is tagged with the one it was found in. A linked worktree has a tree icon, and
  its tooltip names the repository it belongs to.
- **Home folder as `~`** in the paths the Open screen and a worktree's card show (`~/repos/app`);
  tooltips keep the full path. Windows paths are left as they are.

### Changed

- **Push tags with branches** is turned on for existing settings once; turn it off again in
  Settings › Fetch › Push tags with branches.
- **Bringing an MR's or PR's branch up to date** is one split button in the merge panel: it runs
  the way you last chose in that repository (on GitHub, a rebase when the repository allows
  rebase merges, else a merge; on GitLab, Rebase), and its menu has the other way. It's offered
  whenever the branch is behind its target, worked out from your fetched commits, and not only
  when GitHub requires branches to be up to date.
- **In a fork, the graph pins the original project's trunk** (`upstream/main`) with your local
  main, even when main tracks your fork; your fork's own main is no longer pinned by default.
  The pin's Default tooltip says how the fork was told (the forge, or the `upstream` remote).
- **Open screen** sections no longer stretch across a very wide window: the layout is capped at
  1440 px and centred.
- **Clear button in filter boxes:** an × inside the right edge clears the filter, in the sidebar,
  file lists, pickers, the Open screen, Keyboard Shortcuts and the debug logs.
- **Overview ruler on every scrolling diff view:** CSV and TSV tables (with their changes marked)
  and PDFs get the 30px ruler the Source and rendered Markdown diffs have, in place of the slim
  scrollbar. The rendered Markdown diff keeps it even when nothing changed, while it scrolls.

### Fixed

- Go to the clipboard: View all files turns back off when the pasted file is closed, if the paste
  turned it on.
- Clicking or dragging on a rendered Markdown diff's ruler centres the view on the pointer; it
  settled too high while long documents finished rendering.
- Ctrl+Enter (Cmd+Enter) inside a dialog or popover submits the form you're typing in; it did
  nothing there before.
- On Windows, AltGr no longer triggers Ctrl+Alt shortcuts while typing (for example `{` on Czech,
  Hungarian or Polish layouts).
- **Compare** on a merged MR/PR shows the commit it landed as on the target (its merge or squash
  commit) against that commit's parent, fetching the remote when needed, and says so when it can't
  find it. It used to fetch the MR's own head as `origin/mr/<n>`, which the next fetch deleted.
  An open MR's head, fetched for Compare, now stays through later fetches too.
- A long MR/PR's discussion renders in faster: each step that renders a few more comment bodies
  redraws only those threads, not every thread on the timeline.

### Security

- Background workers (the code editor's, the Markdown parser's, PDFs') now run under the app's
  Content Security Policy too; before, only the page did.

## [0.5.0] - 2026-10-09

### Added

- **Inline review comments** on GitHub and GitLab. Open an MR's or PR's **Compare**, and a **+**
  in the diff's gutter comments on a line, or drag it over a range. The comment box has **Add to
  review** (Mod+Enter: a draft kept on the forge, as GitLab's draft notes or GitHub's pending
  review), **Comment now** and **Suggest change**. Threads and your drafts show as cards under
  their lines in every diff mode, outdated ones marked. A resolved thread folds into its author's
  avatar in the gutter, as on GitLab; F9 and Shift+F9 step between threads, and Mod+Alt+C comments
  on the cursor's lines. The rendered Markdown diff takes comments on a block's lines too.
- **Your pending review**, in a boxed panel in the MR view (your drafts, the summary and
  Comment, Approve or Request changes) and as a chip in the top bar ("Reviewing !12 · 3
  pending"). **Submit review…** (Mod+Alt+R) sends the drafts with it; if the forge refuses part of
  it, it says what went through, and trying again sends only the rest. **Discard** arms in place.
  A review left pending on the web comes back when its MR opens.
- **Suggested changes** show as a diff of the lines they replace, highlighted in the file's
  language: in the comment box's Preview, the diff's cards and the MR timeline.
- The diff panel's file list marks files with review threads; clicking the mark again steps
  through them.
- **Rebase from the merge panel:** when an MR's branch is behind its target, GitLab's **Rebase**
  and **Rebase without pipeline**, or GitHub's **Merge main in** and **Rebase onto main**
  (Ctrl+Alt+U).

### Changed

- **The pinned trunk is a pair:** your main branch and the remote branch it tracks both stay at
  the left of the graph. One behind the other, they share the leftmost lane; diverged, the remote
  branch's own commits take the next lane.
- A resolved thread on the MR timeline rolls up into one line, as GitLab shows it; a click opens
  it again.
- The MR view's buttons meet WCAG AA contrast in every theme.

### Fixed

- The MR view's "Its commits aren't fetched into this repository" stayed until the MR was
  reopened. It checks again after a fetch, and when you click it.
- A folder whose name is too long for the file list shows its full path on hover.

## [0.4.0] - 2026-10-08

### Added

- **macOS:** GitBolt runs on Macs with Apple Silicon (macOS 12 or later), from a `.dmg`: drag it
  to Applications. It's ad-hoc signed, not notarized, so the first launch needs
  `xattr -dr com.apple.quarantine /Applications/GitBolt.app` or System Settings › Privacy &
  Security › **Open Anyway**. Chromium runs sandboxed, as elsewhere. Shortcuts use ⌘, with a
  native menu bar. Folders open in a tab from Finder's Open With, the Dock icon or
  `open -a GitBolt <folder>`. Updates replace the app in place, then **Restart GitBolt**.
- **Tab groups:** drop a tab onto another to group them. A coloured chip names the group: click
  it to collapse the group, drag it to move the group, hover it for a list of its tabs, and
  right-click it for its colour, name, New tab in group, Save and close group, Ungroup tabs and
  Delete group. The group's tabs share a coloured line along their top. Drag a tab into or out
  of a group to join or leave it; a tab's menu also has Add to new group, Add to group and
  Remove from group. Saved groups reopen from the tab bar's right-click menu, and groups are
  kept with your tabs.
- Double-clicking the tab bar's empty space opens Open repository.
- **Front matter:** a Markdown file's leading YAML (`---`) or TOML (`+++`) front matter renders
  as a table of keys and values, and the rendered diff shows a changed value word by word.

### Changed

- A rendered Markdown diff opens at its first change, as the source diff does.
- A folder opened when GitBolt starts (or from a second launch) takes the empty Open repository
  tab instead of opening beside it.

### Fixed

- After closing a file in a long history, part of the graph's lanes stayed blank until you
  scrolled.

### Security

- **Dependencies:** KaTeX 0.16.47 to 0.18.10 (prototype pollution could bypass `trust`) and the
  DOMPurify copy bundled with Monaco 3.4.15 to 3.4.16 (`IN_PLACE` advisories), both pinned with
  npm overrides. GitBolt used neither vulnerable feature.

## [0.3.0] - 2026-10-07

### Added

- **Windows:** GitBolt builds, runs and installs on Windows 10 and 11: an NSIS installer (per user,
  no administrator rights) and an MSI (per machine), both unsigned for now, so SmartScreen warns.
  Chromium runs sandboxed, as on Linux. Editors and IDEs, File Explorer, Open with and the folder
  picker use Windows' own.
- **Updates from GitHub Releases.** GitBolt checks for a new release at startup and once a day
  (Settings › Updates, with **Include pre-releases**), and on Help › Check for updates. A pill at
  the bottom right downloads the package for your install, checks it against the release's
  `SHA256SUMS`, and installs it: through your desktop's password prompt (`pkexec`) on Linux, then **Restart
  GitBolt**; on Windows by starting the installer. GitBolt's own version is in the status bar.
- **Reply and resolve** (or unresolve) beside Reply in a resolvable thread (Ctrl+Shift+Enter).
- Software centre metadata in the Linux packages. A `.deb` opened in GNOME Software, Ubuntu's App
  Center or Discover now shows the homepage and a full description, and GNOME Software the MIT
  license; none of them shows a package's icon before it's installed. Once installed, GitBolt
  has AppStream metadata (`dev.gitbolt.desktop`: description, license, links, screenshot and
  release history), icons from 32 px to 512 px, and a Debian machine-readable `copyright` file.
  The Arch package lists the licenses of the code it bundles, not only MIT.

### Changed

- **Push tags with branches** is on by default: a push also sends the annotated tags on the pushed
  commits that the remote lacks (`--follow-tags`), so a release's tag goes out with its commit.
  A settings file that already has it off keeps it off.

### Fixed

- A repeat request GitHub answered with "not modified" failed ("gzip decompression failed"): GitHub
  labels those empty answers as gzipped. It affected the update check and GitHub MR/PR polling.
- In the rendered Markdown diff, an edited heading (`## Windows (in progress)` → `## Windows`) or
  short block showed as removed and added; it now shows as one change, its words diffed.
- A GitLab thread's own system note ("changed this line in version 3 of the diff") showed at the
  bottom of the MR's timeline; it now shows inside its thread.
- GitLab images that an older build had failed to load stayed missing for a day (its "not found" was
  remembered); images are now asked for again. An upload's Open in browser uses GitLab's
  `/-/project/<id>/uploads/…` address, the one GitLab 17 and later serve.

## [0.2.0] - 2026-10-07

### Added

- Comment actions in the MR/PR view, at the right of each comment's header (shown on hover or
  focus):
  - **Add reaction** (a smiley): GitHub's eight reactions; on GitLab the common ones and a search
    of every emoji. Reactions show under the comment as pills ("👍 3"), yours highlighted; a click
    toggles yours at once (put back if the forge refuses), and hovering one says who reacted.
  - **⋮**: Edit and Delete on your own comments (Edit turns the comment into its Markdown box;
    Delete arms in place first), Copy link, and Quote reply.
  - Right-clicking a comment's date offers Copy link and Open in browser; hovering any relative
    date in the view shows the full date and time, in your date format, with the time zone.
- Resolve and unresolve threads (GitLab's resolvable discussions, GitHub's review threads) with the
  circled check on a thread's first comment: green once resolved, naming who resolved it. A
  resolved thread folds its replies under a row saying how many and who replied last; the row
  unfolds any thread, and your choice is kept for the session.
- Emoji autocomplete in the Markdown boxes (comments, replies, descriptions): type `:` and two letters (`:thu`) for a popup at the caret; ↑/↓ choose, Enter or Tab inserts the `:shortcode:`, Esc closes it. It stays quiet in URLs, times and code. `@` offers people the same way (the MR's own first, then the forge's search) and inserts `@username`.
- Keyboard shortcuts for the everyday actions, each also in the command palette:
  - staging: stage or unstage the open file (Ctrl+Shift+S), the hunk or selected lines at the
    diff's cursor (Ctrl+Shift+D); Stage all and Unstage all in the palette;
  - Commit (Ctrl+Enter) from the file list or the diff, not only from the message;
  - Fetch all (Ctrl+L), Pull (Ctrl+Shift+L), Push (Ctrl+Shift+K), a new branch (Ctrl+Shift+N),
    Stash (Ctrl+Alt+S) and Pop (Ctrl+Alt+P);
  - the diff: Hunk, Inline and Split (Ctrl+Shift+1, 2, 3), Source or Rendered for Markdown
    (Ctrl+Shift+V), the next and previous file (F8, Shift+F8), File History (Ctrl+Shift+H)
    and Blame (Ctrl+Shift+B);
  - the keyboard to the sidebar, the graph, the file list or the diff (Alt+1 to Alt+4), and a
    tab by its place (Ctrl+1 to Ctrl+8, Ctrl+9 for the last);
  - on an open MR/PR: Approve (Ctrl+Shift+A), Merge (Ctrl+Shift+M) and Open in browser
    (Ctrl+Shift+O). Approve and Merge still ask first.

- Change an MR/PR's reviewers and assignees from its view: + Add (the same people search as
  Create) and × apply at once, and a change the forge refuses is put back with the reason. On
  GitHub, a reviewer who already reviewed stays: GitHub keeps a submitted review.
- Right-clicking empty space in the tab bar opens a menu: Reopen the last closed tab (Ctrl+Shift+T), Open repository, Clone.
- Auto-merge in the MR/PR view, as GitLab's merge widget has it: while the pipeline or checks
  run, the button is **Set to auto-merge** ("Merge when all checks pass"), with the chosen
  method, squash and delete-source-branch options. Once set, the box says who set it, with
  **Cancel auto-merge**; a failed pipeline says it won't merge. On GitLab it's the merge's
  `auto_merge` (and the older `merge_when_pipeline_succeeds`); on GitHub, GraphQL's auto-merge,
  and a repository that doesn't allow it says so. The sidebar's MR/PR rows show a small mark.
- **Compare** on the MR/PR view's branch card: an icon at the right end of the commits bar that
  shows the MR's changes as a compare in the graph (its merge base, then its head), with the
  compare's files open, so the diff matches the forge's Changes. A head that isn't in the
  repository yet is fetched first (only the MR's or PR's own ref, from the target's remote).
- A review composer: **Review…** in the Approvals card opens Comment, Approve or Request changes
  with a message (optional to approve), as GitHub's review dialog. On GitHub it's one review; on
  GitLab, Request changes also sets your reviewer state to Changes requested where the server
  supports it. Approve still works in one click (armed in place).
- **Subscribe / Unsubscribe** in the MR/PR view's ⋯ menu: the forge's notifications for it.
- Reviewer and assignee limits: on a GitLab project that allows one reviewer or assignee
  (GitLab Free), the card's + swaps the person instead of adding one, in the view and in Create;
  GitHub's 10 assignees are a cap. If the forge drops someone anyway, a toast says who it kept.
- A pencil in the Labels card's corner opens label editing.
- An image viewer: click an image in rendered Markdown (comments, descriptions, previews) to see
  it over the app at 100% (or fitted), zoom with the wheel around the pointer, pan by dragging or
  with the arrow keys; Fit, 100%, Copy image and Open in browser in its toolbar; Esc closes it.
- Videos in GitLab comments play inline and in the viewer. A format the app can't play (H.264 or
  HEVC MP4s) says so, with Open in browser and Open with default app.
- A diff note's `file:line` link opens the diff at that line, centred, with the cursor on it; a
  multi-line note shows `file:100-105` and selects its lines.

- The Debug modal's **Requests** tab: every request the UI makes to the core (graph, file
  contents, commit details, forge calls…) with its duration and outcome, and the git commands it
  ran, a click away in the Commands tab. Slow only and Failed only filters.
- The Commands tab's **Hide reads** (on by default) hides the frequent read-only commands
  (status, diff, log…), keeping the actions, failed commands and the one an error points at.
- A Keyboard shortcuts button in the status bar, left of the git version.
- Every popup trigger toggles: pressing a menu's or picker's button again closes it, and that
  click does nothing else.

### Changed

- The MR/PR view's threads: the first comment's author is on the timeline and its text fills the
  card; replies are compact, a small avatar in their header. Timeline icons sit centred on their
  event's first line, and the date follows the text without a "·". Expanded replies show only
  "Collapse replies" (the count and last reply are the folded row's). A comment on a file leads
  with its author and date, the file link under them. A comment's date underlines on hover and
  opens its Copy link / Open in browser menu on click. The discussion shows a spinner while it
  loads.
- A push refreshes its MR/PR at once, and again a few seconds later, so the new pipeline and
  mergeability show without waiting for the next poll.
- The Keyboard Shortcuts panel (Ctrl+/) lists every shortcut, including the ones that only work
  in a context (with a file open, on an MR/PR), and groups them as Staging, Diff, File history
  and Merge request. Next and Previous change are in the palette too.
- The merge box: Delete source branch, then Squash commits, as on GitLab. The merge method is
  the Merge button's tooltip instead of a line of its own; on GitHub it's chosen in the button's
  dropdown. The status icon is centred on its title line.
- The MR/PR view's Reviewers, Assignees and Labels are cards beside each other, like Pipeline,
  Approvals and Conflicts, with their + in the header; the cards' values are centred, and the
  review buttons look like buttons (Approved stays pressed, in green).
- The branch card's commit bar toggles the commit list from anywhere on it (but Compare, at its
  right end).
- Merges use the forge's own commit messages: the merge box has no message fields.
- A card button that opens something (Review…, a people card's +, the Labels pencil) shows a
  small caret.
- When the MR/PR view's status line wraps (a long name, a narrow dock), Check out, Edit and ⋯
  stay at its right edge, and a narrow card's name gives way to its buttons.

- Fewer git processes: worktrees, the sidebar's refs and ahead/behind counts are read in
  process; a file that keeps changing (a growing log) refreshes at most every 2 s, and a
  worktree you aren't viewing at most every 5 s, counts only. A busy linked worktree went from
  about 130 git processes in 10 s to 3; a fetch from 7 to 1.
- Worktree diffs compare what git would store (autocrlf, `.gitattributes` eol and text, ident,
  working-tree encoding, filter drivers), so a CRLF file no longer reads as every line changed
  in the rendered Markdown diff, and Open in lands on the changed line.
- Diffs open centred on their first change, and Next/Previous change go from what's on screen.
- Blame or History from Diff View opens File History on Changes; from File View, on the file.
- Context menus keep a Local or Remote button that can't apply, disabled with the reason (Delete
  on the checked-out branch), and hovering a row lights the button it runs.
- Confirm popovers keep Cancel and the answer on one row; a destructive one started from the
  keyboard focuses Cancel.
- The bell moved to the top bar, left of Settings.
- The MR/PR hover card: the state chip leads the title (in place of its icon), the branches on
  their own line, and
  only what needs a look (no "No reviews yet" or "No conflicts").
- Sidebar MR/PR rows show a coloured state icon (green open, grey draft).
- Edit mode in the MR/PR view puts the form first (title, description, then reviewers,
  assignees and labels) with full-size Cancel / Save.
- A file opened over the floating MR/PR panel shows on top of it, and the panel's shadow falls
  only to its right. The panel's scrollbar no longer shifts its content.
- Reopening the MR/PR that's open keeps its view; its commit and line counts show at once.
- Compare loads older history instead of fetching when the MR's commits are already local.
- Mermaid 12 (the ELK layout).
- A commit's branch chips: the checked-out branch, then a branch with its remote at the same
  commit (`main` with `origin/main`), then local-only branches, then one checked out in another
  worktree; then remote-only branches and tags.

### Fixed

- After Merge on GitLab, an MR showed as Closed for a while: GitLab's `locked` (it's merging)
  is now **Merging…**, with a spinner, and the view polls quickly until it's merged.
- An armed button's "Click again to …" label no longer grows past the edge of its panel (the
  merge box's Merge, over the graph): it grows toward the side with room.
- Word wrap works on the left side of a split diff after it was inline.
- At an interactive rebase's Edit stop, the commit box could show the parent commit's message.
- A sidebar MR/PR's hover card no longer runs off the bottom of the window when its details
  arrive and it grows, and the status bar no longer covers it.
- A click in the inline branch or tag name input could close it.
- Images uploaded to GitLab comments didn't load (GitLab sends them as generic files), and
  `{width=900 height=575}` after one showed as text; it now sizes the image. A broken image says
  why when hovered.
- A push from the "Push to" panel (a branch without an upstream yet) that the remote rejected
  offered only Pull: it now offers Force push too, with the lease, to the target it was sent to.
- A failed fetch over ssh showed OpenSSH's "connection is not using a post-quantum key exchange"
  warning instead of git's error.

## [0.1.0] - 2026-10-06

The first release, for Linux.

### Added

#### Graph

- A canvas-drawn, virtualized commit graph with lanes, branch and tag chips, author avatars,
  stash nodes, and the working tree's changes (WIP) as the top row.
- A pinned trunk lane. By default it's your local counterpart of the upstream's default branch,
  and it is fork-aware.
- One chip per branch across remotes, hover cards, and branch-hover highlighting.
- Resizable columns with a smart fit, and a committer date column with a choice of date formats.
- Compare two commits, with swap. Multi-select with Ctrl+click and Shift ranges.
- Find (Ctrl+F).

#### Repositories and the app

- Tabs for several repositories and their worktrees, and an Open Repository screen with clone.
- One running instance: launching GitBolt again opens the folder in the running window.
- A toolbar, a status bar, and a sidebar with branches, remotes, tags, stashes, worktrees and
  MRs/PRs. The sidebar has a filter, a tree view and resizable panels.
- A command palette (Ctrl+P), Settings (Ctrl+,), a keyboard shortcuts panel (Ctrl+/), and
  back/forward navigation (mouse buttons, Alt+Left/Right).
- Profiles. Each has its own tabs, forge accounts and an optional extra git config file.
- Ten themes, dark and light, with per-lane colour overrides, density presets and app zoom.
- The window reopens where it was.
- An Activity log of git commands and their output, including hook output.

#### Staging and commits

- Stage and unstage files, hunks and lines. Discard changes.
- Commit, amend, and edit the last commit's message. The commit box shows the author identity
  and keeps a draft per worktree.
- Undo and redo for most operations. An Undo dropdown can undo an older action out of order when
  nothing later depends on it.
- Autostash, and Remove stale lock for a leftover `index.lock`.
- English (US) spell check in the commit message and the MR/PR text fields, with suggestions
  on right-click. The dictionary ships with the app, so it works offline.

#### Branches, sync and history tools

- Branches: create, rename, set the upstream, delete (local and remote), check out and reset.
  Worktrees too.
- Stashes: push, apply, pop and drop.
- Fetch, pull and push, plus a background fetch on a schedule.
  - After a rewrite, Push force-pushes with a lease.
  - "Push tags with branches" is optional.
  - Add a remote, fetch a single remote, and remove a remote (undoable).
- Merge and rebase, with a conflict banner and a three-way merge tool that has a conflict
  minimap.
- A visual interactive rebase editor, with conflict prediction, pause, and an Edit stop.
- Cherry-pick and revert, each with a no-commit variant. Tags: create, delete and push.
- File history with each version's diff, blame, and restore a file from a commit.
- Stacked branches: detection, Push stack, and Rebase stack onto its base.
- Commit signature verification.

#### Diffs and files

- A Monaco-based diff viewer with Shiki highlighting. It has inline, split and hunk modes,
  word-level changes and sticky scroll.
- Image diffs: side by side, swipe, onion skin and difference, with zoom and pan.
- Binary files shown as hex.
- File View: rendered or source, an editable working-tree file, and Create file.
- "Open in…" your editor or file manager, including old versions of a file.

#### Markdown

- Rendered Markdown in MR/PR descriptions and comments, and in File View, with GitHub-like
  styles, code blocks with Copy, and Mermaid diagrams.
- A Write/Preview editor for replies, edits and new MRs/PRs.
- Rendered Markdown diffs, inline or side by side, with word-level changes and an overview
  ruler.
- Images from hosts other than the forge's load only after a click.

#### Pull requests and merge requests (GitHub and GitLab)

- Forge accounts with personal access tokens (GitHub classic and fine-grained tokens, GitLab
  tokens), kept in the system keyring.
- MR/PR badges on branch chips, an MR/PR section in the sidebar, and hover cards.
- An MR/PR view docked beside the graph.
  - Reply, approve, request changes, edit, and mark as draft.
  - Merge, and check out (adding the fork's remote first).
  - Pipeline status and an activity timeline.
- A Create MR/PR panel with templates, people and label pickers, and drafts.
- Stacked MRs/PRs: a stack table in descriptions, retargeting, and an after-merge flow.
- Avatars from your forge accounts and from Gravatar. Each source can be turned off.
- MR/PR data is cached across restarts. Polling is paced by the forges' rate limits.

#### Packaging

- A `.deb` package and an Arch Linux package, both with Chromium's setuid sandbox helper.
- Daily, redacted, size-capped log files.
