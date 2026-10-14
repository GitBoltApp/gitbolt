# Playground and showcase repositories

`just playground` builds ten throwaway repositories for trying GitVolt, in `~/gitvolt-playground`
(or the folder you pass: `just playground DIR`). Add that folder in GitVolt ("Add a folder") and
every repo in it is listed. Each repo is a direct child of the folder; the bare remotes live in
`.remotes/`, linked worktrees in `.worktrees/`, both hidden from the folder scan. Re-running the
recipe resets the folder, but only if it is empty or carries the `.gitvolt-playground` marker.

## What it builds

- **orbital**: a 2D space-trading game in Rust, over a thousand commits by six people over two years.
  Every file type GitVolt previews is in its history: sprites, the HUD font, sounds, the design
  PDF, the press kit, tables and a save file. One branch (`balance/fuel-rework`) that conflicts with
  `main`, an interactive-rebase candidate stacked on a second branch, branches ahead, behind and diverged from origin, two stashes and staged and unstaged
  changes on `main`, and a linked worktree on `release/1.2` with changes of its own. A teammate's push is not fetched yet: `git -C .remotes/orbital-origin.git
  update-ref refs/heads/main refs/demo/teammate` plays it, then fetch. Its `origin` is named by
  its forge address (`https://gitlab.example.com/orbital/orbital.git`), as the demo's fake GitLab
  serves it. The playground maps that address to `.remotes/orbital-origin.git`
  (`url.<path>.insteadOf` in the repo's config); in a `showcase` build, plain git reaches the
  bundled origin with
  `git -c url.$PWD/../origin.git.insteadOf=https://gitlab.example.com/orbital/orbital.git fetch`.
- **basic**: the game's website. A small history with a merged branch, a tag, a stash and a dirty
  linked worktree.
- **sync**: the modding kit, a remote that moved. Fetch, pull and push. `main` is behind,
  `feature/lua-hooks` has diverged, and `feature/mod-manifest` has no upstream.
- **conflicts**: merge `feature/price-rework` into `main` for text, binary and delete/modify
  conflicts, then resolve them.
- **stack**: `feature/cargo-model` > `cargo-ui` > `cargo-tests`, stacked on a `main` that has
  moved on. Rebase a branch and watch the stack follow; multi-select commits and use Squash. Its
  branches are pushed to an `origin` named by its forge address
  (`https://gitlab.example.com/orbital/cargo.git`), a project with no merge requests yet; plain git
  reaches the bundled origin as Orbital's does (`.remotes/stack-origin.git`, or
  `git -c url.$PWD/../origin.git.insteadOf=https://gitlab.example.com/orbital/cargo.git fetch`).
- **wip_staging**: uncommitted changes to a ship. Stage and unstage files and hunks, then commit.
- **rebase-lab**: `feature/docking` with six commits. Start an interactive rebase onto `main` and
  drag commits; the conflict warning appears and clears as the order changes.
- **previews**: open "Refresh the press kit for 1.1" and pick a file. Images (PNG, GIF, ICO, SVG),
  audio, video, a font, a PDF, HTML, CSV and TSV, Markdown and a save file in hex, each previewed
  and diffed.
- **submodules**: `libs/netcode` is checked out past its recorded commit, with an edit; its row
  shows both. `libs/shaders` is recorded but not initialised. The palette (Ctrl+P) has the
  Submodules actions.
- **lfs**: the title art through Git LFS, with no git-lfs needed to build it. Its two versions
  diff as images; `art/ships.psd` was never downloaded (Download needs git-lfs). Initialising it clones from a local folder, which git refuses unless `protocol.file.allow` is `always` in your global config (git 2.38.1 and later); GitVolt runs git as a terminal would, so the same applies.

## Showcase or fixture

`gitvolt-harness showcase <name> <dir>` builds one of the ten above on its own. `<dir>` must be
empty, missing, or a folder a previous run made. The names match the core's test fixtures, but
the content does not: the test fixtures back the Rust and e2e tests and must keep their exact
contents. `gitvolt-harness fixture <name> <dir>` builds the test fixture for `basic`, `sync`,
`conflicts`, `stack`, `wip_staging` and `rebase_lab`. For `orbital`, `previews`, `submodules` and
`lfs` it builds the showcase content, so `fixture` accepts every showcase name.

Each build writes `<dir>/repo` plus whatever else it needs beside it (a bare `origin.git`, submodule
sources). `just playground` then moves the pieces into the folder and rewrites the remote and
worktree paths to match.

## Orbital's layout

- `repo`: the working repository, with the full history and the refs and stashes described above.
- `origin.git`: a bare remote. Its objects are borrowed from `repo` through
  `objects/info/alternates` (a relative path to `../../repo/.git/objects`). The playground repacks
  it into its own pack before moving it, since the relative path would break.
- `wt-release`: a linked worktree of `repo` on `release/1.2`, with an unstaged fix and its
  changelog line (the playground moves it to `.worktrees/orbital-release`).
- `forge.json`: the demo's fake GitLab (`forge.json` v1, the harness fake forge's seed without
  tokens): every merge request the history implies (`orbital/orbital!<iid>`, with heads, bases and
  merge commits), pipelines, approvals and a few threads on the open ones, and the six people.
- `refs/demo/teammate` in `origin.git`: a commit the teammate has pushed but that is not fetched.

## How Orbital is made

Everything is generated from `orbital::SEED` (`crates/gitvolt-harness/src/orbital/mod.rs`), so a
build gives the same commit ids on the same platform.

- **Corpus** (`crates/gitvolt-harness/src/orbital/corpus/`): the text of the game. Rust items,
  shaders, docs, tables and devlog entries, each block versioned and tagged with the feature that
  introduces it. The file format is described at the top of `orbital/corpus.rs`.
- **Story** (`orbital/story.rs`): turns the corpus and `corpus/features.txt` into steps. Each
  feature becomes a branch's commits; every step leaves the code building.
- **Schedule** (`orbital/schedule.rs`): lays the steps on the two-year calendar: feature branches,
  GitLab-style merge commits, direct commits on `main`, tuning commits, and releases (tags
  `v0.1.0` to `v1.2.1`).
- **History** (`orbital/history.rs`): writes one `git fast-import` stream. Generating the whole
  history takes about a second; one `git commit` per commit would take about a minute.
- **Finish** (`orbital/finish.rs`): adds what needs real git: the bare origin, the teammate's
  commit, upstreams, stashes, the staged working tree, the release worktree and `forge.json`
  (`orbital/forge.rs`).

The art is drawn by the harness's own code (`orbital/art.rs`, `scenes.rs`, `glyphs.rs`,
`design_doc.rs`, `data.rs`), not taken from anywhere. `gitvolt-harness media preview <dir>` writes
every sprite scaled up to `<dir>`, with a `contact.png` sheet and an `index.html` to open.

## Encoded media

Four files are encoded with ffmpeg, once, from frames and samples the harness makes:
`trailer-v1.webm`, `trailer-v2.webm`, `menu-loop.ogg` and `docking-chime.opus`, in
`crates/gitvolt-harness/src/fixture_data/`. They're committed, so building never needs ffmpeg.
`scripts/gen-fixture-media.sh HARNESS` re-encodes them; run it only to change them.

## Website data

`just demo-data` builds every showcase repo with the harness, packs each into
`site/demo-data/<name>.gbdemo` and writes `manifest.json`, which the website reads.

The bundles are rebuilt on Linux, and a dependency bump (flate2's zlib-rs, libm) can change their
bytes without any change to the repos. Regenerate `site/demo-data` only at deliberate points (per
site release, say): `orbital.gbdemo` is 3.4 MB, so each re-commit grows the repository by that much.
