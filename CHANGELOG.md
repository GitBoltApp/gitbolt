# Changelog

All notable changes to GitBolt are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

The first alpha, for Linux.

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
