# Changelog

All notable changes to GitBolt are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added

- **Reply and resolve** (or unresolve) beside Reply in a resolvable thread (Ctrl+Shift+Enter).

### Changed

- **Push tags with branches** is on by default: a push also sends the annotated tags on the pushed
  commits that the remote lacks (`--follow-tags`), so a release's tag goes out with its commit.
  A settings file that already has it off keeps it off.

### Fixed

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
