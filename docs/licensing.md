# Licensing and third-party notices

GitBolt is MIT licensed (`LICENSE`). Its packages also contain other people's code: the Rust
crates the binary links, the npm packages bundled into the interface, the Chromium Embedded
Framework (CEF) with Chromium, and an English spell-check dictionary. Their licenses require their notices to ship with the binary, so
every package carries them, generated fresh by each `just package`.

## What ships, and where

| File | Contents |
| --- | --- |
| `LICENSE` | GitBolt's own license |
| `THIRD-PARTY-NOTICES-rust.txt` | Every crate `gitbolt-app` links, grouped by license |
| `THIRD-PARTY-NOTICES-ui.txt` | Every npm package in the UI bundle, grouped by license; Shiki's grammars and themes with their own licenses; notices packages ship (Monaco's `ThirdPartyNotices.txt`) |
| `CEF-LICENSE.txt` | CEF's license, from the CEF distribution the build used |
| `CHROMIUM-CREDITS.html.gz` | Chromium's credits for everything it bundles, from the same distribution (about 20 MB of HTML, gzipped to about 2 MB) |
| `DICTIONARY-en-US-LICENSE.txt` | The spell-check dictionary's source and license (below) |

- The `.deb` installs them in `/usr/share/doc/gitbolt/`, with a `copyright` file in Debian's
  machine-readable format (DEP-5, written by `scripts/package-meta.py`): GitBolt is MIT, CEF and
  Chromium's files BSD-3-Clause, the dictionary SCOWL's license, each pointing to the file above.
  The control file has `License: MIT` too, which GNOME Software shows for a `.deb` that isn't
  installed yet, and the AppStream metainfo says `project_license` MIT.
- The Arch package has the same files, plus `/usr/share/licenses/gitbolt`, a symlink to
  `/usr/share/doc/gitbolt` (Arch's location for license files). Its `license` lines are MIT, the
  licenses in the two notices files' summaries, `BSD-3-Clause` and `LicenseRef-SCOWL`.
- The Windows installers put them in `licenses\` in the install folder.
- On macOS they're inside the app, in `GitBolt.app/Contents/Resources/licenses/`
  (`crates/gitbolt-app/packaging/macos/dmg.conf.json`).
- In the app, **Help > About GitBolt > Open source licenses** shows all of them except the
  Chromium credits, which are too large to embed in the app; the page gives their installed path instead.
  The UI build copies the files into `ui/dist/licenses/`, which the app embeds, so they're in a
  lazy chunk, not the startup bundle.

Each notices file lists every package under the license GitBolt uses it under (for "MIT OR
Apache-2.0", the one chosen by the allow-list's order, below) with the copyright lines from its
license files. The full text of each license follows its list once; texts that differ in more
than their copyright lines (a crate that adds its own terms, a header from a copied source file)
are printed separately, each with the packages that use it.

## How they're generated

`just licenses` generates everything. `just package` runs the same two steps around its build,
so the notices can't go stale.

1. **`scripts/licenses.sh`** writes `target/licenses/`:
   - **Rust:** `cargo about generate` (cargo-about 0.9.2) produces JSON for `gitbolt-app`'s graph:
     the crates it links on `x86_64-unknown-linux-gnu` (`x86_64-pc-windows-msvc` for the Windows
     installers: `scripts/package-windows.ps1` runs the script in Git for Windows' bash, which
     passes that target; `aarch64-apple-darwin` for the `.dmg`, from `scripts/package-macos.sh`
     on a Mac), without dev-only or build-time crates and
     without GitBolt's own workspace crates (the harness isn't in the graph at all). Then
     `scripts/notices.py` groups it and writes the text file. cargo-about was chosen over
     `cargo-bundle-licenses` or a script over `cargo metadata` because it does the hard parts
     reliably: it evaluates each crate's SPDX expression against the allow-list, identifies
     license files by their text, falls back to SPDX's canonical text when a crate ships none,
     and filters the graph by target and dependency kind.
     Install it once: `cargo install cargo-about --version 0.9.2 --locked --features cli`.
   - **CEF and Chromium:** from the CEF distribution `cargo tauri` builds against, in
     `~/.cache/tauri-cef/<version>/` (`%LOCALAPPDATA%\tauri-cef` on Windows,
     `~/Library/Caches/tauri-cef` on macOS, or `$CEF_PATH`),
     with the version taken from the `cef`
     crate in `Cargo.lock`. The build's unpacked copy keeps only `CREDITS.html`, so `LICENSE.txt`
     is read from the downloaded archive beside it. On a machine that hasn't built the app yet,
     the script first downloads CEF the way the app build does.
2. **The UI build** (`npm run build`, which `cargo tauri build` runs) writes
   `ui/dist/licenses/THIRD-PARTY-NOTICES-ui.txt` through the Vite plugin in `ui/build/licenses.ts`.
   The plugin works from the modules actually in the main and worker bundles, so
   devDependencies and tree-shaken packages never appear and nothing bundled is missed.
   Shiki's grammars and themes come from many upstream projects; the plugin lists each one in the
   bundle with the license and source the `tm-grammars` and `tm-themes` projects record (or, where
   they record none, the one found upstream: see below), and appends the sections of their
   `NOTICE` files with the bundled ones' upstream license texts. Those two packages are
   devDependencies pinned to the versions the installed Shiki was built from, and the build
   fails if the grammars don't match them.

`.deb` packaging takes the files from `target/licenses/` and `ui/dist/licenses/` (the `files`
map in `crates/gitbolt-app/tauri.conf.json`); `scripts/check-deb.sh`, `scripts/package-arch.sh`
and `scripts/check-arch-pkg.sh` fail if any of them is missing or empty, as
`scripts/package-macos.sh` does for the `.dmg`'s app.

## Windows packaging tools

The Windows build uses three tools that aren't GitBolt dependencies (`scripts/package-windows.ps1`
downloads them, pinned, into `target\windows-tools`). Only NSIS puts code of its own in a
package:

- **NSIS 3.11** builds the `-setup.exe`, which contains NSIS's installer stub. The stub and its
  plug-ins are under the zlib/libpng license, and the installer is compressed with bzip2, whose
  decompressor is under the bzip2 license; neither asks for a notice in a binary. Not LZMA: NSIS's
  LZMA module is under the Common Public License 1.0, a copyleft license.
- **WiX 5.0.2** (Microsoft Reciprocal License) builds the MSI. The MSI has no custom actions and
  no WiX UI, so no WiX code ships in it.
- **rcedit 2.0.0** (MIT) writes GitBolt's icon, version information and manifest into
  `GitBolt.exe` and `GitBolt.dll`.

`GitBolt.exe` itself is CEF's `bootstrap.exe`, covered by `CEF-LICENSE.txt`.

## The spell-check dictionary

Chromium downloads its spell-check dictionaries from Google, and GitBolt's Chromium can't reach
the network (PRIVACY.md). So the packages ship the English (US) one, and the app copies it into
Chromium's profile at startup (`Cef::bundled_dictionary`, vendor/tauri-runtime-cef/GITBOLT-PATCH.md).

- **The file:** `crates/gitbolt-app/dictionaries/en-US-10-1.bdic`, committed (452 KB), installed
  as `/usr/share/GitBolt/dictionaries/en-US-10-1.bdic`. It is the exact file Chromium downloads
  for en-US: `en-US-10-1.bdic` from `chromium/deps/hunspell_dictionaries` at
  `cccf64a8acc951afe3f47fee023908e55699bc58`, the commit Chromium 152.0.7977.83's `DEPS` pins
  (SHA-256 `a075b01d9b015c616511a9e87da77da3d9881621db32f584e4606ddabf1c1100`). Committed rather
  than fetched at build time, so a package build needs no network and can't get another file.
- **Its license:** the `en_US` Hunspell dictionary derived from SCOWL (version 2020.12.07, Kevin
  Atkinson): SCOWL's permissive terms ("Permission to use, copy, modify, distribute and sell
  these word lists … provided that the above copyright notice appears in all copies"), with the
  affix file under Geoff Kuenning's BSD-style Ispell license and public-domain word lists. Chromium
  adds the 561 words of its `en_US.dic_delta` (Chromium's license, already in `CEF-LICENSE.txt`
  and the Chromium credits). `crates/gitbolt-app/dictionaries/en-US-LICENSE.txt` records the
  source and has the dictionary's README verbatim, with every notice; it ships as
  `DICTIONARY-en-US-LICENSE.txt` and in the app's license list. No copyleft term applies, so
  the allow-list (below), which only the Rust crates and the npm packages go through, needs no
  entry for it.

## The license allow-list

`accepted` in `about.toml` is the list of licenses GitBolt ships code under: MIT, Apache-2.0,
BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, Zlib, MPL-2.0, EPL-2.0, Unicode, OFL-1.1, CC0-1.0, BSL-1.0,
Unlicense and CDLA-Permissive-2.0. The UI plugin reads the same list. A crate or package under
any other license, or with no recognizable license, fails the build with its name, so a
copyleft dependency (GPL, LGPL, AGPL) is never added unnoticed. Review it, then either drop the
dependency or record the decision:

- **Rust:** add the license to `accepted`, or clarify a crate whose metadata is wrong
  (`about.toml` has one for `ring`, whose license files cargo-about doesn't pick up on its own).
- **UI:** `ui/build/license-exceptions.json`. Its `packages` entries give a license to a package
  whose `package.json` declares none (checked against its license file). The rest is about
  Shiki's grammars and themes, below.

### Weak copyleft: MPL-2.0 and EPL-2.0

Both are file-level copyleft: they bind the licensed files themselves, not the MIT code beside
them, so shipping those files unmodified under their license is fine. The obligations are that
the files stay under their license (its text ships in the notices) and that recipients can get
their source.

- **elkjs** (Mermaid's ELK layout, the default since Mermaid 12) is declared `EPL-2.0` by its
  `package.json` (the upstream project offers "EPL-2.0 OR GPL-3.0-or-later" in places; we take
  EPL-2.0, the choice the OR allows). Its JavaScript is in the Mermaid chunk, minified and
  unmodified. `ui/build/licenses.ts` writes a "Source code of the packages under a file-level
  copyleft license" section into `THIRD-PARTY-NOTICES-ui.txt` for every bundled package under
  EPL-2.0 (`WEAK_COPYLEFT_SOURCE`): its npm package and source repository
  (https://github.com/kieler/elkjs). The EPL-2.0 text is in the list above it like any other.
  If we ever modify elkjs, publish the modified files' source and say so there.

### Shiki's grammars and themes

- **Copyleft ones are never bundled.** `dropped` lists the grammars and themes left out for their
  licenses: the grammars `ada`, `gnuplot`, `nginx`, `org` and `racket` (GPL-3.0) and `ahk2`
  (recorded as "GNU"), and the theme `aurora-x` (GPL-3.0). It also lists `dax` (`"(none)"`), whose
  project states no license anywhere. A file in one of those languages, or a fenced block in a
  Markdown file, shows as plain text.
  - Grammars: the UI imports `ui/src/diff/shikiLanguages.ts`, never `shiki/langs`, whose registry
    imports every grammar Shiki ships. That file is Shiki's registry without the dropped grammars,
    and with GitBolt's own files for the replaced ones (below), generated by
    `node ui/scripts/gen-shiki-languages.mjs`; `shikiLanguages.test.ts` fails when it no longer
    matches Shiki's registry or the `dropped` and `replaced` lists, so rerun the script after a
    Shiki upgrade.
  - Themes: `ui/src/theme/editorThemes.ts` imports the nine themes the app themes use by name,
    never `shiki/themes`.
  - The build fails if a grammar or theme under GPL, LGPL or AGPL is bundled, whatever the
    exceptions say, or if a dropped one is.
- **Unrecorded licenses are researched upstream.** Where `tm-grammars` or `tm-themes` record no
  license, or NOASSERTION, the `grammars` and `themes` entries give the license the upstream
  project states, at the commit `tm-grammars` pins: `recorded` is what `tm-grammars` records,
  `license` the upstream's (an SPDX expression), `source` where it says so. Its text is
  `ui/build/grammar-licenses/<id>.txt`, or the `NOTICE` section `tm-grammars` already has. The
  notices list the grammar under that license with its source, and print the texts.
  - `licenses` lists the reviewed, permissive licenses outside the allow-list that a grammar may
    use: the TextMate bundles' license (`LicenseRef-TextMate-Bundle`, "Permission to copy, use,
    modify, sell and distribute this software is granted"), `BSD-2-Clause-Views` and
    `Apache-2.0 WITH LLVM-exception`.
  - `apl`, `hurl` and `rel` are MIT, declared in the project's `package.json` or README though it
    has no license file; `dream-maker` is MIT as a port of an MIT project (Atomic Dreams). Their
    texts are in `ui/build/grammar-licenses/`.
  - The build fails if a bundled grammar or theme is outside the allow-list with no entry, if
    what `tm-grammars` records no longer matches `recorded` (review it again), or if an entry's
    license is copyleft, unreviewed, `"(none)"` (the project states none) or has no text. Every
    bundled grammar's license is recorded, so the build has no warnings about them.
- **A grammar with no license upstream is replaced, or dropped.** `replaced` lists the Shiki
  grammars GitBolt swaps for its own file, `ui/src/diff/grammars/<id>.json`: a TextMate grammar from
  a permissively licensed project, converted from its plist to JSON (with Python's `plistlib`)
  with `name` set to the language id. They keep Shiki's id, so files and fenced blocks find them
  as before; `ui/src/diff/language.ts` also maps the shader-stage extensions (`.vert`, `.frag`,
  `.geom`, `.tesc`, `.tese`, `.comp`, `.vsh`, …) to `glsl`, and a `tclsh` shebang to `tcl`.

  | Id | Replaces Shiki's (no license) | GitBolt's file, from | License |
  | --- | --- | --- | --- |
  | `glsl` | `polym0rph/GLSL.tmbundle` | `euler0/sublime-glsl` `GLSL.tmLanguage` at `59a5f8a`, the grammar GitHub Linguist uses | Unlicense (in the allow-list) |
  | `tcl` | `sleutho/tcl` | `textmate/tcl.tmbundle` `Syntaxes/Tcl.plist` at `f06f801`, the grammar Linguist uses | `LicenseRef-TextMate-Bundle` |

  Each entry gives the `license`, the `source` file at that commit and the `reason`; the text is
  `ui/build/grammar-licenses/<id>.txt`. The notices list the grammar with its license and source
  ("GitBolt's copy … in place of Shiki's"), and print the text. The build fails if Shiki's copy of
  a replaced grammar is bundled, or if a file in `ui/src/diff/grammars/` has no `replaced` entry,
  no text, or a license outside the allow-list and `licenses`.

## Updating

- **New dependency, new license:** the build names it. Check its terms, then extend the
  allow-list or an exception as above.
- **Shiki upgrade:** pin `tm-grammars` and `tm-themes` in `ui/package.json` to the versions that
  Shiki release was built from (the build compares every bundled grammar with `tm-grammars`), run
  `node ui/scripts/gen-shiki-languages.mjs`, then review the build's errors and warnings for new
  or changed licenses: drop a copyleft grammar (add it to `dropped` and rerun the script),
  research an unrecorded one upstream, and replace or drop one whose project states no license.
- **CEF upgrade:** the notices follow the `cef` crate's version. Check the dictionary's version
  in that Chromium's `components/spellcheck/common/spellcheck_common.cc` (`{"en-US", "-10-1"}`);
  if it changed, replace the `.bdic` (and the name in `crates/gitbolt-app/src/lib.rs`,
  `tauri.conf.json` and the package checks) with the one its `DEPS` pins, and update its
  license file.
