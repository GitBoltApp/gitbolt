# Playground and showcase repositories

`just playground` builds throwaway repositories to try GitBolt on (basic, sync, conflicts, stack,
wip_staging, rebase-lab, previews, submodules, lfs) in `~/gitbolt-playground`. Each comes from a named fixture, and
`gitbolt-harness fixture <name> <dir>` builds any one of them on its own: the repository is
`<dir>/repo`, with anything it needs (a bare `origin.git`, submodule sources) beside it. `<dir>`
must be empty, missing, or a folder a previous fixture run made.

Three of them show off what GitBolt previews and the repository kinds it handles. They're made up
and built offline (`crates/gitbolt-harness/src/fixtures_showcase.rs`), and can be built on their
own too:

```sh
cargo build -p gitbolt-harness
target/debug/gitbolt-harness fixture previews   ~/gitbolt-showcase/previews
target/debug/gitbolt-harness fixture submodules ~/gitbolt-showcase/submodules
target/debug/gitbolt-harness fixture lfs        ~/gitbolt-showcase/lfs
```

- **previews**: "Add the gallery", then "Refresh the gallery", which changes every file. Open the
  second commit and pick a file: a PNG (image diff), a WAV (two players), a WebM video, a TrueType
  font (its name, a pangram and its glyphs), a PDF (one page, then two, side by side), an HTML page
  with its stylesheet and image (rendered), a page loading a CDN script (the bar above it says what
  it doesn't load), a CSV and a TSV (a table, diffed row by row), Markdown with front matter, and
  an SVG. `audio/chime.opus` and `scripts/deploy.sh` (for Open in) come with the first commit.
- **submodules**: `libs/parser` is checked out past its recorded commit with an edited file, so its
  row shows both; `libs/theme` is recorded but not initialised. "Update the parser to Parse the
  body" moves a pointer: its diff names the two commits. The palette (Ctrl+P) has the Submodules
  actions. The sources (`parser-src`, `theme-src`) are `file://` URLs beside the repository, so
  build it where you'll use it rather than moving it.
- **lfs**: `*.png` and `*.psd` go through Git LFS, with no git-lfs needed to build it: pointers are
  committed and the objects put in `.git/lfs/objects`. The cover's two versions are there (an
  image diff of the real files); `art/layers.psd` never was ("not downloaded", with Download).
  Downloading, the palette's LFS actions and Track/Stop tracking need git-lfs installed.

The media in `crates/gitbolt-harness/src/fixture_data/` were synthesized for these fixtures with
ffmpeg (a Game of Life pattern, ffmpeg's test card and three sine tones), and the font and images
are drawn by the fixture code, so they're ours to ship.
