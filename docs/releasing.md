# Releasing GitVolt

A release is a tag. `just release <version>` prepares the release commit and tag locally;
pushing them starts [.github/workflows/release.yml](../.github/workflows/release.yml), which
builds the `.deb`, the Arch package, the `.rpm`, the two Windows installers and the macOS
`.dmg`, checks them, and uploads them to a **draft** GitHub release. You review the draft and publish it. Nothing is published
automatically.

## Before you start

- **main must be green.** The release workflow builds and checks the packages, but it doesn't run
  the test suite (there's no CI on main yet). Run `just lint`, `just test` and `just e2e` on the
  commit you're releasing.
- **CHANGELOG.md's `## [Unreleased]` section lists the release's changes.** Its contents become
  the release notes. `just release` refuses an empty section. The dated sections are also the
  packages' AppStream release history (`scripts/package-meta.py`), and the newest one's tag pins
  the metainfo's screenshot URL, so push the tag with the release.

## Steps

1. **Prepare the release** on an up-to-date main, with no uncommitted changes:

   ```sh
   just release 0.1.0-alpha.1
   ```

   It sets the version in `crates/gitvolt-app/tauri.conf.json`, the workspace `Cargo.toml` and
   `Cargo.lock`, and `ui/package.json` and its lockfile. Then it turns `## [Unreleased]` into
   `## [0.1.0-alpha.1] - <today>` under a fresh, empty `## [Unreleased]`, commits
   "Release 0.1.0-alpha.1" and creates the annotated tag `v0.1.0-alpha.1`. It never pushes.

   It refuses to run when you're not on main, when tracked files have uncommitted changes, when
   main is behind `origin/main`, or when the version is invalid, already tagged, or not newer
   than every `v*` tag. If a step fails partway, it restores the files it edited.
   To undo a release you haven't pushed: `git tag -d v0.1.0-alpha.1 && git reset --hard HEAD~1`.

2. **Push the commit and the tag together** (the command `just release` prints):

   ```sh
   git push origin main v0.1.0-alpha.1
   ```

   GitVolt's Push does the same with **Push tags with branches** on (the default), since the
   tag is annotated. The build then runs on main's push, warm (see
   [Which run builds](#which-run-builds)). Pushed apart, it still releases: see there.

3. **Wait for the workflow:** Actions → Release (see [Build time and cost](#build-time-and-cost)).
   It fails fast when the tag doesn't match `tauri.conf.json`'s version or CHANGELOG.md has no
   section for it.

4. **Review the draft** under Releases. It's titled "GitVolt 0.1.0-alpha.1" and has the
   changelog section as its notes, plus the `.deb`, the `.pkg.tar.zst`, the `.rpm`, the Windows
   `-setup.exe` and `.msi`, the macOS `.dmg`, and `SHA256SUMS`. A
   version with a pre-release part (`-alpha.1`, `-rc.2`) is marked pre-release. Edit the notes
   if needed, and install the packages from the draft to try them.

5. **Publish** the draft. GitHub marks a published release as the latest unless it's a
   pre-release.

6. **The website's downloads update by themselves.** Publishing starts the Site downloads
   workflow: it writes `site/data/release.json` for the release, commits it to main as
   "Site: downloads for 0.1.0" and deploys the website. A pre-release is offered only while
   there's no other release. Pull main (`git pull --rebase`) before you next push
   it. See [docs/website.md](website.md#downloads).

## Asset names are an API

Installed GitVolts find their update by these names (`crates/gitvolt-core/src/updates/release.rs`),
in the releases of `GitVoltApp/gitvolt` only. GitBolt 0.6.1, the app under its old name, also takes
these names, from `GitVoltApp/gitvolt` (or `GitBoltApp/gitbolt` while that one doesn't exist), so
it updates to GitVolt; GitBolt 0.6.0 and earlier can't, and need a GitVolt package installed by
hand. So keep the names exactly as they are, and keep `SHA256SUMS` in every release: an update
whose package `SHA256SUMS` doesn't list is never installed. The website's downloads
(`scripts/site-release.py`) find the packages by these names too.

| Install | Asset |
|---|---|
| `.deb` | `GitVolt_<version>_amd64.deb` |
| Arch | `GitVolt-<pkgver>-1-x86_64.pkg.tar.zst` (`<pkgver>`: the version without the pre-release's `-`) |
| `.rpm` (Fedora, openSUSE) | `GitVolt-<version>-1.x86_64.rpm` (the version as in the `.deb`'s name: `GitVolt-0.1.0-alpha.1-1.x86_64.rpm`, although the package's Version is `0.1.0~alpha.1`) |
| Windows (NSIS) | `GitVolt_<version>_x64-setup.exe` |
| Windows (MSI) | `GitVolt_<version>_x64.msi` |
| macOS | `GitVolt_<version>_aarch64.dmg` (Apple Silicon; an Intel Mac takes `GitVolt_<version>_x64.dmg`, which no release has yet). The image holds `GitVolt.app` at its top level |
| all | `SHA256SUMS` (`sha256sum` output listing each package) |

The tag stays `v<version>`, and the release's body (the CHANGELOG section) is what the update
dialog shows. Drafts are never offered; a release marked pre-release (or with a pre-release
version) is offered only to users who include pre-releases, or who run a pre-release.

Each package says how it was installed in an `install-kind` file beside the binary, which the
app reads at run time (one build goes into both packages of a platform, so the binary itself
can't know):

- the `.deb` ships `/usr/share/GitVolt/install-kind` = `deb`
  (`crates/gitvolt-app/packaging/install-kind-deb`, through tauri.conf.json), and
  `scripts/package-arch.sh` rewrites it to `arch`, `scripts/package-rpm.sh` to `rpm`;
- the NSIS installer writes `install-kind` = `nsis` beside `GitVolt.exe`, and the MSI installs
  `packaging/windows/install-kind-msi` (`msi`) there; `scripts/package-windows.ps1` checks the
  MSI has it;
- the `.dmg`'s GitVolt.app has `Contents/Resources/install-kind` = `dmg` (the bundle's place for
  its files: `crates/gitvolt-app/packaging/install-kind-dmg`, through
  `packaging/macos/dmg.conf.json`, which only `just package-macos` passes, so a plain
  `cargo tauri build` bundle counts as a build from source); `scripts/package-macos.sh` checks it.
  An update mounts the new `.dmg` and copies its `GitVolt.app` over the running bundle, so the
  image must keep holding `GitVolt.app` at its top level.

No file: a build from source, which is only offered the release page. `just package`,
`just package-windows` and `just package-macos` also bake the stamped version in
(`GITVOLT_BUILD_VERSION`), which the status bar and the update check use.

## The move from GitBoltApp/gitbolt

The project was called GitBolt until 0.7.0, and its repository was `GitBoltApp/gitbolt`. On
2026-10-15 it was transferred to `GitVoltApp/gitvolt` and renamed in one call, so GitHub redirects
the old addresses. 0.6.1 bridged the two names (it checks `GitVoltApp/gitvolt` first, takes
`GitVolt_*` packages and updates into GitVolt); 0.6.0 and earlier only know `GitBoltApp/gitbolt`
and the GitBolt asset names, so they can't follow (the README says so). GitVolt itself checks
`GitVoltApp/gitvolt` only and takes only `GitVolt_*` packages.

- **Never delete or rename the `GitBoltApp` organization, nor create a `gitbolt` repository in
  it.** It would take over the old address: an install still on 0.6.0 (or on 0.6.1, if
  `GitVoltApp/gitvolt` were missing) would check it and its updates would be captured, and
  GitHub's redirect for old links would end. The old Pages address
  redirects through the `GitBoltApp/gitboltapp.github.io` repository for the same reason.
- **Installs still on 0.6.0 or earlier at the transfer** must reinstall by hand from the GitVolt
  release.
- **GitVolt's packages replace an installed GitBolt**, since the update only installs the package:
  - `.deb`: `Conflicts` and `Replaces` `git-bolt (<< 0.7.0)` (`apt install -y` then removes it);
  - `.rpm`: `Obsoletes: gitbolt < 0.7.0` (dnf, zypper and `rpm -U` then replace it);
  - Arch: `conflicts=('gitbolt<0.7.0')` and `replaces=('gitbolt<0.7.0')`. 0.6.1's in-app update
    answers pacman's conflict question itself (`--ask=4`); a `pacman -U` by hand asks first;
  - none of them `Provides` `gitbolt`;
  - the metainfo `<replaces>` `dev.gitbolt.desktop`, and every package is named `gitvolt` (`fix-deb.sh`
    renames Tauri's `git-volt`);
  - Windows: the installers remove GitBolt's install (NSIS) or keep the MSI's UpgradeCode;
  - macOS: every `GitVolt_*.dmg` contains `GitVolt.app`.
    0.6.1 installs it beside `GitBolt.app` and removes that on Restart; GitVolt offers to remove a
    `GitBolt.app` left beside it (a notice once, and Settings › Updates), moving it to the Trash only
    when it is GitBolt's and GitBolt isn't running.

## Versions

A release version is [SemVer](https://semver.org) without build metadata: `X.Y.Z` or
`X.Y.Z-<pre-release>`. The pre-release is a lowercase word (`alpha`, `beta`, `rc`), then
optional dot-separated lowercase words or numbers: `0.1.0-alpha.1`, `0.2.0-rc.2`. Identifiers
that mix letters and digits, like `alpha10`, are refused, because SemVer and pacman would sort
them differently. The rules are in `scripts/version.py`.

Each package manager gets a version that sorts the same way as SemVer, with pre-releases
before the release:

| SemVer (tag `v…`) | `.deb` and `.rpm` Version | Arch `pkgver` | Files |
|---|---|---|---|
| `0.1.0-alpha.1` | `0.1.0~alpha.1` | `0.1.0alpha.1` | `GitVolt_0.1.0-alpha.1_amd64.deb`, `GitVolt-0.1.0alpha.1-1-x86_64.pkg.tar.zst`, `GitVolt-0.1.0-alpha.1-1.x86_64.rpm` |
| `0.1.0-rc.2` | `0.1.0~rc.2` | `0.1.0rc.2` | `GitVolt_0.1.0-rc.2_amd64.deb`, `GitVolt-0.1.0rc.2-1-x86_64.pkg.tar.zst`, `GitVolt-0.1.0-rc.2-1.x86_64.rpm` |
| `0.1.0` | `0.1.0` | `0.1.0` | `GitVolt_0.1.0_amd64.deb`, `GitVolt-0.1.0-1-x86_64.pkg.tar.zst`, `GitVolt-0.1.0-1.x86_64.rpm` |
| local build of `0.1.0` | `0.1.0+202610051325.ab4dbf9e` | `0.1.0.202610051325.ab4dbf9e` | stamped, as before |

- Debian's `~` sorts before anything, so `0.1.0~alpha.1` is older than `0.1.0`
  (`scripts/fix-deb.sh` writes it; Tauri only accepts SemVer).
- rpm sorts `~` before anything too, and treats `+` as a separator, so the RPM takes the `.deb`'s
  Version as is (Release `1`; `scripts/rpm-pkg.py`). Its file name keeps the SemVer form, as
  the `.deb`'s does.
- pacman's `vercmp` treats a leftover part that starts with a letter as older, but one that
  starts with a `.` as newer: `0.1.0.alpha.1` would sort *after* `0.1.0`, so the word follows the
  number directly (`scripts/arch-pkg.py`).
- `scripts/test-version-order.sh` (part of `just test-scripts`) checks the whole order with
  `dpkg --compare-versions`, and with `vercmp` and rpm's `rpm.vercmp` when they're installed. Run
  it with `GITVOLT_TEST_DOCKER=1` to use them in `archlinux:latest` and `fedora:latest`
  containers.

Windows wants numeric versions: the MSI's `ProductVersion` and the files' `FILEVERSION` are
`X.Y.Z.0` for every build of `X.Y.Z`, its pre-releases and local builds included. Windows Installer
compares only the first three fields, so the MSI allows same-version upgrades
(`AllowSameVersionUpgrades`): any build of `0.1.0` replaces whichever `0.1.0` build is installed,
pre-release or not, and an older `X.Y.Z` is refused. The full version stays in the file names
(`GitVolt_0.1.0-alpha.1_x64-setup.exe`, `GitVolt_0.1.0-alpha.1_x64.msi`), in the files' version
strings (Properties > Details) and in the NSIS installer's entry in Settings > Apps; the MSI's
entry shows `0.1.0.0`.

Local `just package` builds stay stamped (`<version>+<UTC time>.<commit>`), so each one installs
over the last. `GITVOLT_RELEASE_VERSION=<version> just package` builds the plain version the way
the workflow does; it must equal `tauri.conf.json`'s version.

## What the workflow does

After Plan (see [Which run builds](#which-run-builds)), the Linux, Windows and macOS builds run
side by side, then the release job:

1. **Build** (read-only access to the repository):
   - checks the tag against `tauri.conf.json`'s version and extracts the release notes from
     CHANGELOG.md (`scripts/changelog.py notes <version> CHANGELOG.md`);
   - installs the toolchain: the system packages (`libgtk-4-dev`, `patchelf`, `dpkg-dev`, `zstd`,
     `binutils`, `cmake`, `ninja-build`, and `appstream` and `desktop-file-utils` for
     `check-deb.sh`), stable
     Rust, Node 22, `just`, `tauri-cli` 3.0.0-alpha.4 and cargo-about 0.9.2;
   - runs `just package` with `GITVOLT_RELEASE_VERSION` set. That generates the third-party
     license notices (`scripts/licenses.sh`, failing on a license outside `about.toml`'s
     allow-list; see [licensing.md](licensing.md)), builds, and runs `fix-deb.sh`, `check-deb.sh`
     (which also checks the notices are in the `.deb`), `package-arch.sh` and `package-rpm.sh`;
   - runs `just check-arch-pkg` (Docker), which installs the Arch package in `archlinux:latest`
     and checks it, its notices included, then `just check-rpm-pkg`, which does the same for the
     RPM in `fedora:latest` with dnf;
   - writes `SHA256SUMS`, and keeps the packages, the checksums and the notes as a workflow
     artifact for 3 days.
2. **Windows** (`windows-latest`, read-only): stable Rust, Node 22, `just`, cargo-about 0.9.2
   and Visual Studio's Ninja; runs `just package-windows` with `GITVOLT_RELEASE_VERSION` set (see
   [Windows installers](#windows-installers)), and keeps both installers and their checksums as
   a workflow artifact.
3. **macOS** (`macos-15`, Apple Silicon, read-only): stable Rust, Node 22, `just`, CMake and
   Ninja, `tauri-cli` and cargo-about; runs `just package-macos` with `GITVOLT_RELEASE_VERSION`
   set (see [macOS disk image](#macos-disk-image)), and keeps the `.dmg` and its checksum as a
   workflow artifact. Its caches (cargo, the two cargo tools, the CEF archive) are saved from main
   only, as the others are.
4. **Release** (`contents: write`): verifies the three jobs' checksums and merges them into one
   `SHA256SUMS`, adds build provenance attestations for every package (see below), and creates
   the draft release, or updates it on a re-run.

The packages' `Depends` come from the build machine's libraries (dpkg-shlibdeps), so packages
built on the 24.04 runner install on Ubuntu 24.04 and later. The RPM's `Requires` come from the
same libraries (glibc 2.39's symbol versions): Fedora 40 and later. A local `just package` on a newer
distribution can require newer library versions; publish the workflow's packages, not local ones.

## Which run builds

Only runs on main save caches: a tag's run can restore caches saved on main, but not another
tag's. So a release builds on main, and each release warms the next one, as long as GitHub keeps
the caches (it evicts them after 7 days unused; the next release then builds cold). One build
per release, decided by the workflow's first job, **Plan**:

- **A push to main that changes `Cargo.lock`** (a release's version bump does): if the pushed
  commit carries a `v*` tag, this run releases it. Otherwise it does nothing (a few seconds).
- **A pushed `v*` tag:** waits for main's run on the same commit. If that one releases the tag,
  this run stops. If not (the tag was pushed after its commit, or main's push didn't run), it
  builds and drafts the release itself, from cold caches. Nothing is lost either way.
- **Run workflow** (Actions → Release → Run workflow, on main) with a **tag**: releases that tag
  (its commit, warm). The way to redo or rescue a release by hand.

## Windows installers

`just package-windows` (on Windows; `scripts/package-windows.ps1`) builds once and packages twice,
into `target\release\bundle\windows\`:

- **`GitVolt_<version>_x64-setup.exe`** (NSIS): installs for the current user, no administrator
  rights, into `%LOCALAPPDATA%\Programs\GitVolt`. Silent: `/S`, and `/D=<folder>` (last,
  unquoted) for another folder. Settings > Apps lists it; its uninstaller is
  `uninstall.exe` (`/S` for silent). Installing a newer one over it runs the old uninstaller first.
- **`GitVolt_<version>_x64.msi`** (WiX v5): installs for all users into `Program Files\GitVolt`
  (administrator rights), for managed deployment: `msiexec /i GitVolt_<version>_x64.msi /qn`.

Both add a Start menu shortcut and "Open in GitVolt" on folders in File Explorer, and leave the
user's settings and data (`%APPDATA%\gitvolt`, `%LOCALAPPDATA%\gitvolt`,
`%LOCALAPPDATA%\com.gitvolt.desktop`) on uninstall.

Both replace GitBolt (the app's name before 0.7.0): the MSI by its unchanged UpgradeCode, the NSIS
installer by running GitBolt's per-user uninstaller. A GitBolt MSI install isn't removed by the NSIS
installer, nor the other way round. The NSIS installer asks to close a running GitBolt first.

The installed folder is CEF's sandboxed layout: `GitVolt.exe` is CEF's `bootstrap.exe` (with
GitVolt's icon, version information and `packaging/windows/GitVolt.exe.manifest`), which loads
`GitVolt.dll` (gitvolt-app built as a DLL) and runs Chromium sandboxed; then CEF's runtime files,
`dictionaries\` and the license notices in `licenses\`. The bootstrap must come from the CEF build
the DLL links, and nothing at run time checks that, so the script compares `bootstrap.exe`'s and
`libcef.dll`'s versions with `Cargo.lock`'s CEF before staging.

The packaging tools are pinned and downloaded on first use into `target\windows-tools` (checked
against their SHA-256; WiX through `dotnet tool install`): NSIS 3.11, WiX 5.0.2 and rcedit 2.0.0.
The MSI also goes through Windows Installer's ICE checks.

### Signing

The installers aren't signed yet, so SmartScreen warns about them ("Windows protected your PC" >
More info > Run anyway). The hook is in place: `GITVOLT_SIGN_COMMAND`, a command that signs the
file path appended to it in place (for example `signtool sign /fd sha256 /tr <timestamp URL> /td
sha256 /f <certificate>`). With it set, `package-windows.ps1` signs, in order:

1. `GitVolt.exe` and `GitVolt.dll`, **with the same certificate**: a signed bootstrap only loads a
   DLL signed with its own certificate, so signing one without the other, or with two
   certificates, makes the app refuse to start;
2. the NSIS uninstaller (while the installer is built, through NSIS's `!uninstfinalize`), then the
   installer;
3. the MSI.

In the workflow, set it in the "Build the installers" step of the Windows job, from a secret (the
step's comment marks the place).

## macOS disk image

`just package-macos` (on a Mac; `scripts/package-macos.sh`) builds the release `GitVolt.app` and
`target/release/bundle/dmg/GitVolt_<version>_aarch64.dmg` with the Tauri CLI's own bundlers: the
`.dmg` holds `GitVolt.app` and a link to `/Applications`. The app is CEF's layout (the framework
and the helper apps in `Contents/Frameworks`; docs/dev-setup.md), with the spell-check
dictionary, the `install-kind` marker and the license notices in `Contents/Resources`, and an
`Info.plist` that declares folders as a document type (Open With). The script then checks the
signature (`codesign --verify --deep --strict`), the marker, the notices and the document type,
in the bundle and again in the mounted image.

**Signing.** The app is **ad-hoc signed** (`signingIdentity: "-"` in `tauri.macos.conf.json`),
inside out by the bundler, with the hardened runtime and CEF's entitlements; the `.dmg` itself
isn't signed. Gatekeeper rejects it (`spctl --assess` says "rejected"), so a downloaded copy
needs `xattr -dr com.apple.quarantine /Applications/GitVolt.app` or **Open Anyway** once
(README.md). An update downloaded by GitVolt itself carries no quarantine flag, so it needs
neither. The hook for real signing: a Developer ID Application identity in place of `"-"`
(the Tauri CLI reads `APPLE_SIGNING_IDENTITY` and a certificate from `APPLE_CERTIFICATE` /
`APPLE_CERTIFICATE_PASSWORD`), then notarization (`xcrun notarytool submit --wait` and
`xcrun stapler staple` on the `.dmg`; the CLI does both given `APPLE_ID`, `APPLE_PASSWORD` and
`APPLE_TEAM_ID`). Set them in the macOS job's "Build the disk image" step from secrets (its
comment marks the place). That needs an Apple Developer Program membership.

**Versions.** `CFBundleShortVersionString` and `CFBundleVersion` are the package version as is
(`0.4.0-rc.1`, or a local build's stamp): macOS shows it in Finder and nothing compares it, since
the updater uses GitVolt's own version.

**Intel Macs.** Not built yet: the release has only the `aarch64` `.dmg`. An Intel build would
be a second, separate `GitVolt_<version>_x64.dmg` (the updater already picks its own
architecture's), cross-compiled on the same runner with CEF's x64 distribution. A universal app
would need both CEF distributions, two builds, and `lipo` on the app, every helper and the
framework's libraries, doubling the download for everyone.

## Dry run

Actions → Release → **Run workflow**, on main, with the tag left empty. It builds and checks the
packages from the branch's version, as the plain version, and keeps them as a workflow artifact
(3 days). It creates no release and no tag. A missing CHANGELOG section is only a warning. It
also warms the caches.

## Re-running and fixing

- **A transient failure** (a download, the Arch mirror in `check-arch-pkg`, Fedora's in
  `check-rpm-pkg`): use "Re-run failed
  jobs". Re-running only the release job reuses the run's build artifact (kept 3 days).
- **Re-running for the same tag** updates the draft's title, notes and pre-release flag, and
  replaces its assets (`gh release upload --clobber`). If the release is already published, the
  job fails and leaves it untouched.
- **A broken release that needs a code fix:** delete the draft, delete the tag
  (`git push origin :refs/tags/v0.1.0-alpha.1` and `git tag -d v0.1.0-alpha.1`), fix it on
  main, and release again. Once a version is published, don't reuse it: release the next one.

## Build provenance

The release job attests every package with `actions/attest-build-provenance`, so anyone can
check that a file came from this workflow:

```sh
gh attestation verify GitVolt_0.1.0-alpha.1_amd64.deb --repo GitVoltApp/gitvolt
```

Attestations need a public repository, or GitHub Enterprise Cloud for a private one. While the
repository is private, the step is skipped unless the repository variable `GITVOLT_ATTEST` is
`true` (set it only on a plan that supports them). `SHA256SUMS` is always uploaded.

## Build time and cost

Estimated times on a GitHub-hosted runner (private repositories get the 2-vCPU, 8 GB Linux
runner; public ones get 4 vCPUs, roughly halving the compile steps):

| Step | Cold caches (first run) | Warm caches |
|---|---|---|
| Setup (checkout, apt, Rust, Node, `npm ci`) | 3–4 min | 2–3 min |
| `tauri-cli` and `cargo-about` installs | 10–15 min (compiled) | seconds (cached) |
| CEF download (~310 MB) | 1 min | restored from the cache |
| `just package`: Rust release build | 30–45 min | 10–15 min (only GitVolt's own crates) |
| `just package`: UI build, `.deb`, Arch package, `.rpm` | 6–8 min | 6–8 min |
| `just check-arch-pkg` | 3–5 min | 3–5 min |
| `just check-rpm-pkg` | 2–3 min | 2–3 min |
| Release job | 1 min | 1 min |
| **Total** | **about 55–80 min** | **about 25–35 min** |

The job's timeout is 120 minutes. The Windows and macOS jobs run at the same time and take about
as long (their Rust builds are the longest steps); on a private repository Windows minutes count
double and macOS minutes ten times.

The repository is private, so the runs count against the account's included Actions minutes
(Linux runners at a 1× rate: 2,000 minutes a month on GitHub Free, 3,000 on Team). A release is
roughly 30 minutes warm and 65 or more cold, and so is each dry run. Caches (about 3–5 GB:
the Rust target and registry, the CEF archive, the two cargo tools) use the repository's 10 GB cache
allowance, not the storage quota, and are evicted after 7 days unused. The workflow artifact
(about 300 MB) counts against the Actions storage quota (500 MB on Free) for its 3 days.
