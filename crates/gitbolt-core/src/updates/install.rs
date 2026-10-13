//! How this GitBolt was installed, and the commands that install an update over it.
//!
//! Each package says how it was installed in a one-word file beside the binary, `install-kind`,
//! read at run time: one build goes into every package of a platform, so the binary can't know.
//! - Linux: the `.deb` ships `deb` (crates/gitbolt-app/tauri.conf.json), and
//!   `scripts/package-arch.sh` and `scripts/package-rpm.sh` rewrite it to `arch` in the Arch
//!   package and `rpm` in the RPM.
//! - Windows: the NSIS installer writes `nsis` beside `GitBolt.exe` (packaging/windows/gitbolt.nsi),
//!   and the MSI installs a file saying `msi` (gitbolt.wxs).
//! - macOS: `GitBolt.app` carries `dmg` in `Contents/Resources` (tauri.macos.conf.json), the
//!   bundle's place for its files; the app looks there instead of beside the binary.
//!
//! No file: a build from source, which only links to the release page.
//!
//! The commands are built here and run by an `UpdateRunner` (the app's runs them; tests and the
//! harness only record them).

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use ts_rs::TS;

/// The file beside the binary that names the install kind.
pub const INSTALL_KIND_FILE: &str = "install-kind";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum InstallKind {
    Deb,
    Arch,
    /// The RPM (Fedora, RHEL, openSUSE): dnf, else zypper, else plain rpm installs the update.
    Rpm,
    Nsis,
    Msi,
    /// GitBolt.app from the `.dmg`: an update replaces the bundle in place.
    Dmg,
    /// A build from source: no package to update, only the release page.
    #[serde(rename = "none")]
    Unpackaged,
}

impl InstallKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "deb" => Some(Self::Deb),
            "arch" => Some(Self::Arch),
            "rpm" => Some(Self::Rpm),
            "nsis" => Some(Self::Nsis),
            "msi" => Some(Self::Msi),
            "dmg" => Some(Self::Dmg),
            "none" => Some(Self::Unpackaged),
            _ => None,
        }
    }

    /// Windows installers replace the running app's files, so GitBolt quits once one starts.
    pub fn quits_to_install(self) -> bool {
        matches!(self, Self::Nsis | Self::Msi)
    }
}

/// The install kind: `install-kind` in `dir` (the running binary's folder, or a macOS bundle's
/// `Contents/Resources`), else a build from source. An unknown word counts as none.
pub fn detect_install_kind(dir: Option<&Path>) -> InstallKind {
    let file = dir.and_then(|d| std::fs::read_to_string(d.join(INSTALL_KIND_FILE)).ok());
    file.as_deref().and_then(InstallKind::parse).unwrap_or(InstallKind::Unpackaged)
}

/// How an Arch install updates (the dialog asks once, and remembers).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum ArchMethod {
    /// `pkexec pacman -U` on the downloaded package.
    Pacman,
    /// The user's AUR helper: GitBolt only shows its command.
    Aur,
}

/// What installs an RPM here: the first of dnf (Fedora, RHEL) and zypper (openSUSE) that is
/// installed, else rpm itself, which can't fetch missing dependencies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RpmTool {
    Dnf,
    Zypper,
    Rpm,
}

impl RpmTool {
    /// The tool on this system, looked up on PATH and in the system's bin folders (pkexec runs
    /// it with its own PATH).
    pub fn detect() -> Self {
        let mut dirs: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).collect()).unwrap_or_default();
        dirs.extend(["/usr/bin", "/usr/sbin", "/bin", "/sbin"].map(PathBuf::from));
        Self::pick(|name| dirs.iter().any(|d| d.join(name).is_file()))
    }

    fn pick(installed: impl Fn(&str) -> bool) -> Self {
        if installed("dnf") {
            Self::Dnf
        } else if installed("zypper") {
            Self::Zypper
        } else {
            Self::Rpm
        }
    }

    /// The install as root: `dnf install -y <file>`; `zypper --non-interactive install
    /// --allow-unsigned-rpm <file>` (zypper refuses an unsigned package unless told, and GitBolt
    /// has already checked it against `SHA256SUMS`); `rpm -U <file>`.
    fn install_args(self, file: &str) -> Vec<&str> {
        match self {
            Self::Dnf => vec!["dnf", "install", "-y", file],
            Self::Zypper => vec!["zypper", "--non-interactive", "install", "--allow-unsigned-rpm", file],
            Self::Rpm => vec!["rpm", "-U", file],
        }
    }

    /// The same for the user to run with sudo (it asks before it installs); `file` is quoted.
    fn manual(self, file: &str) -> String {
        match self {
            Self::Dnf => format!("sudo dnf install {file}"),
            Self::Zypper => format!("sudo zypper install --allow-unsigned-rpm {file}"),
            Self::Rpm => format!("sudo rpm -U {file}"),
        }
    }
}

/// A program and its arguments, never a shell line; `cwd` when it needs one.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InstallCommand {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<PathBuf>,
}

impl InstallCommand {
    fn new(program: &str, args: &[&str]) -> Self {
        Self { program: program.into(), args: args.iter().map(|a| a.to_string()).collect(), cwd: None }
    }

    /// The command as a shell line, for the log and to copy.
    pub fn display(&self) -> String {
        std::iter::once(self.program.as_str()).chain(self.args.iter().map(String::as_str)).map(quote).collect::<Vec<_>>().join(" ")
    }
}

/// `s` quoted for a POSIX shell when it needs it.
pub fn quote(s: &str) -> String {
    if !s.is_empty() && s.bytes().all(|b| b.is_ascii_alphanumeric() || b"-_./=+:@%,".contains(&b)) {
        s.to_string()
    } else {
        format!("'{}'", s.replace('\'', r"'\''"))
    }
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

/// What installs `file` (a verified download) for `kind`:
/// - deb: `pkexec apt install -y <absolute file>` (polkit asks for the password). Absolute: pkexec
///   doesn't keep the working directory, and apt only takes a path that starts with `/` or `./`
///   as a file to install;
/// - arch: `pkexec pacman -U --noconfirm <file>`, plus `--ask=4` for a GitVolt package
///   ([`arch_install_args`]);
/// - rpm: [`rpm_install_command`] with this system's [`RpmTool`];
/// - nsis: the installer itself, with its normal UI; msi: `msiexec /i <file>` (UAC asks);
/// - dmg: [`DMG_INSTALL`] over `bundle`, the running app's `.app` (none outside one);
/// - none for a build from source.
pub fn install_command(kind: InstallKind, file: &Path, bundle: Option<&Path>) -> Option<InstallCommand> {
    file.file_name()?;
    match kind {
        InstallKind::Deb if file.is_absolute() => Some(InstallCommand::new("pkexec", &["apt", "install", "-y", &text(file)])),
        InstallKind::Deb => None,
        InstallKind::Arch => Some(InstallCommand { program: "pkexec".into(), args: arch_install_args(file), cwd: None }),
        InstallKind::Rpm => rpm_install_command(file, RpmTool::detect()),
        InstallKind::Nsis => Some(InstallCommand::new(&text(file), &[])),
        InstallKind::Msi => Some(InstallCommand::new("msiexec", &["/i", &text(file)])),
        InstallKind::Dmg => Some(InstallCommand::new("/bin/sh", &["-c", DMG_INSTALL, "gitbolt-update", &text(file), &text(bundle?)])),
        InstallKind::Unpackaged => None,
    }
}

/// `pacman -U --noconfirm <file>`. `--noconfirm` takes each question's default, and "Remove the
/// conflicting package?" defaults to no, so on its own it fails a package that conflicts with an
/// installed one: GitVolt's, with `conflicts=('gitbolt')` (`replaces=` only counts in a `-Su` from
/// a repository, never in a `-U`). So a `GitVolt-*` package also gets `--ask=4`: `--ask` answers
/// the question kinds of its bitmask the other way, and 4 is libalpm's
/// `ALPM_QUESTION_CONFLICT_PKG`. It says yes to removing any installed package the new one (or a
/// dependency it pulls in) conflicts with, so a GitBolt package, which has no conflict to resolve,
/// never gets it.
fn arch_install_args(file: &Path) -> Vec<String> {
    let gitvolt = file.file_name().is_some_and(|n| n.to_string_lossy().starts_with("GitVolt-"));
    let ask = gitvolt.then_some("--ask=4");
    ["pacman", "-U", "--noconfirm"].into_iter().chain(ask).map(String::from).chain([text(file)]).collect()
}

/// `pkexec <tool's install> <absolute file>`: absolute, since pkexec doesn't keep the working
/// directory, and dnf and zypper take only a path (not a bare name) as a file to install.
pub fn rpm_install_command(file: &Path, tool: RpmTool) -> Option<InstallCommand> {
    if !file.is_absolute() || file.file_name().is_none() {
        return None;
    }
    let file = text(file);
    Some(InstallCommand::new("pkexec", &tool.install_args(&file)))
}

/// A `.dmg` update, as a script of its two arguments (never spliced into it): the verified image
/// and the running app's bundle. It mounts the image read-only, unbrowsed (no Finder window, no
/// volume on the desktop), and copies its `GitVolt.app` (the project's new name), else its
/// `GitBolt.app`, with `ditto` (signature and attributes kept) beside the bundle under a hidden
/// name. That replaces the bundle with renames in the same folder, under the bundle's own name;
/// except that a `GitBolt.app` updated to `GitVolt.app` becomes `GitVolt.app` beside it (taking
/// the place of one already there), and the old `GitBolt.app` is left for Restart to remove once
/// this process has exited ([`retired_bundle`]): its helpers may still load from it. Then it
/// detaches. The running process keeps its open files; the new bundle takes effect on Restart
/// ([`relaunch_target`] finds it). GitBolt's own downloads carry no quarantine flag (it isn't
/// sandboxed and doesn't ask for `LSFileQuarantineEnabled`), so the copy doesn't either.
pub const DMG_INSTALL: &str = r#"set -eu
dmg=$1 app=${2%/}
dir=${app%/*} name=${app##*/}
new="$dir/.$name.new.$$" old="$dir/.$name.old.$$"
mnt=$(mktemp -d "${TMPDIR:-/tmp}/gitbolt-update.XXXXXX")
finish() { rm -rf "$new"; hdiutil detach -quiet "$mnt" 2>/dev/null || hdiutil detach -quiet -force "$mnt" 2>/dev/null || true; rmdir "$mnt" 2>/dev/null || true; }
trap finish EXIT
hdiutil attach -nobrowse -readonly -noautoopen -mountpoint "$mnt" "$dmg" >/dev/null
src=GitVolt.app
[ -d "$mnt/$src" ] || src=GitBolt.app
[ -d "$mnt/$src" ] || { echo "The disk image has no GitVolt.app or GitBolt.app." >&2; exit 1; }
to=$app
[ "$name:$src" != GitBolt.app:GitVolt.app ] || to="$dir/GitVolt.app"
ditto "$mnt/$src" "$new"
if [ -e "$to" ] || [ -L "$to" ]; then mv "$to" "$old"; fi
mv "$new" "$to" || { if [ -e "$old" ] || [ -L "$old" ]; then mv "$old" "$to"; fi; exit 1; }
rm -rf "$old""#;

/// The `.app` bundle `exe` runs from (`<bundle>/Contents/MacOS/<exe>`), if it is in one.
pub fn app_bundle(exe: &Path) -> Option<PathBuf> {
    let contents = exe.parent().filter(|d| d.file_name().is_some_and(|n| n == "MacOS"))?.parent()?;
    let bundle = contents.parent().filter(|_| contents.file_name().is_some_and(|n| n == "Contents"))?;
    bundle.extension().is_some_and(|e| e == "app").then(|| bundle.to_path_buf())
}

/// Whether the update can replace `bundle`: the bundle and its folder are writable by this user.
/// No (`/Applications` without admin rights, a translocated or mounted copy): the manual steps.
#[cfg(unix)]
pub fn bundle_replaceable(bundle: &Path) -> bool {
    use nix::unistd::{access, AccessFlags};
    let writable = |p: &Path| access(p, AccessFlags::W_OK).is_ok();
    bundle.is_dir() && writable(bundle) && bundle.parent().is_some_and(writable)
}

#[cfg(not(unix))]
pub fn bundle_replaceable(_bundle: &Path) -> bool {
    false
}

/// The command to run by hand when the privileged one couldn't (no `pkexec`, the password
/// prompt was cancelled): `sudo apt install <file>`, `sudo pacman -U <file>`, the RPM's with this
/// system's [`RpmTool`] (`sudo dnf install <file>`); for a `.dmg`,
/// `open <file>`, which shows the image's GitBolt and an Applications link to drag it to.
/// Absolute paths, so it works from any folder.
pub fn manual_command(kind: InstallKind, file: &Path) -> Option<String> {
    let f = quote(&text(file));
    match kind {
        InstallKind::Deb => Some(format!("sudo apt install {f}")),
        InstallKind::Arch => Some(format!("sudo pacman -U {f}")),
        InstallKind::Rpm => Some(RpmTool::detect().manual(&f)),
        InstallKind::Dmg => Some(format!("open {f}")),
        _ => None,
    }
}

/// `GitBolt` → `GitVolt`, `gitbolt` → `gitvolt`: the project's new name in a file name.
fn renamed(name: &std::ffi::OsStr) -> std::ffi::OsString {
    name.to_string_lossy().replace("GitBolt", "GitVolt").replace("gitbolt", "gitvolt").into()
}

/// Where an update into GitVolt may have put the binary `exe` was, most renamed first. Only the
/// install's own names change, never the folders above it:
/// - in a bundle: `GitBolt.app` → `GitVolt.app` beside it (as [`DMG_INSTALL`] does), and the
///   binary's name: `GitVolt.app/Contents/MacOS/GitVolt`, `…/GitBolt`, `GitBolt.app/…/GitVolt`;
/// - elsewhere: the binary and its folder (`/usr/share/GitBolt/gitbolt` →
///   `/usr/share/GitVolt/gitvolt`, `/usr/share/GitBolt/gitvolt`, `/usr/share/GitVolt/gitbolt`).
fn renamed_binaries(exe: &Path) -> Vec<PathBuf> {
    let Some(bin) = exe.file_name() else { return Vec::new() };
    let new_bin = renamed(bin);
    let (home, new_home) = match app_bundle(exe) {
        Some(bundle) => {
            let gitvolt = (bundle.file_name().is_some_and(|n| n == "GitBolt.app")).then(|| bundle.with_file_name("GitVolt.app"));
            (bundle.join("Contents/MacOS"), gitvolt.map(|b| b.join("Contents/MacOS")))
        }
        None => {
            let Some(folder) = exe.parent() else { return Vec::new() };
            let new_folder = folder.file_name().map(renamed).filter(|n| Some(n.as_os_str()) != folder.file_name());
            (folder.to_path_buf(), new_folder.map(|n| folder.with_file_name(n)))
        }
    };
    let mut out = Vec::new();
    if let Some(h) = &new_home {
        out.extend([h.join(&new_bin), h.join(bin)]);
    }
    out.push(home.join(&new_bin));
    out.retain(|p| p != exe);
    out
}

/// What Restart starts: after an update into GitVolt (`into_gitvolt`, its package was GitVolt's),
/// the first of [`renamed_binaries`] that's there, else `exe`; after any other, `exe` while it's
/// there, else the same. Nothing there: `exe` (its start then says so).
pub fn relaunch_target(exe: &Path, into_gitvolt: bool) -> PathBuf {
    if !into_gitvolt && exe.is_file() {
        return exe.to_path_buf();
    }
    renamed_binaries(exe).into_iter().find(|p| p.is_file()).unwrap_or_else(|| exe.to_path_buf())
}

/// The old `GitBolt.app` that a `.dmg` update into GitVolt left beside `GitVolt.app`, for Restart to
/// remove once this process has exited: when `exe` runs from `GitBolt.app` and `target` (what
/// Restart starts) is in the `GitVolt.app` beside it.
pub fn retired_bundle(exe: &Path, target: &Path) -> Option<PathBuf> {
    let old = app_bundle(exe).filter(|b| b.file_name().is_some_and(|n| n == "GitBolt.app"))?;
    (app_bundle(target) == Some(old.with_file_name("GitVolt.app")) && target.is_file()).then_some(old)
}

/// Starts `exe` again once process `pid` (this one) has exited: the single-instance guard is
/// free by then, so the new version starts on its own instead of handing over to the old one.
/// Then, before it starts, `retire` (a bundle the update replaced) is removed. `exe`, `pid` and
/// `retire` are arguments to the script, never part of it.
pub fn relaunch_command(exe: &Path, pid: u32, retire: Option<&Path>) -> InstallCommand {
    let retire = retire.map(text).unwrap_or_default();
    InstallCommand::new("/bin/sh", &["-c", r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; [ -z "$3" ] || rm -rf "$3"; exec "$2""#, "gitbolt-relaunch", &pid.to_string(), &text(exe), &retire])
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_kind_from_the_file_beside_the_binary() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(detect_install_kind(Some(dir.path())), InstallKind::Unpackaged, "no file: a build from source");
        assert_eq!(detect_install_kind(None), InstallKind::Unpackaged);
        // What each package writes: the .deb's and Arch's with a newline, NSIS's with CRLF.
        for (text, kind) in [("deb\n", InstallKind::Deb), ("arch\n", InstallKind::Arch), ("rpm\n", InstallKind::Rpm), ("nsis\r\n", InstallKind::Nsis), ("msi\n", InstallKind::Msi), ("msi", InstallKind::Msi), ("dmg\n", InstallKind::Dmg), ("snap", InstallKind::Unpackaged), ("", InstallKind::Unpackaged)] {
            std::fs::write(dir.path().join(INSTALL_KIND_FILE), text).unwrap();
            assert_eq!(detect_install_kind(Some(dir.path())), kind, "{text:?}");
        }
        // The files the packaging ships, as they are in the repository.
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for (file, kind) in [("crates/gitbolt-app/packaging/install-kind-deb", InstallKind::Deb), ("packaging/windows/install-kind-msi", InstallKind::Msi), ("crates/gitbolt-app/packaging/install-kind-dmg", InstallKind::Dmg)] {
            let text = std::fs::read_to_string(repo.join(file)).unwrap();
            assert_eq!(InstallKind::parse(&text), Some(kind), "{file}");
        }
        assert_eq!(serde_json::to_value(InstallKind::Unpackaged).unwrap(), "none");
    }

    #[test]
    fn builds_each_kinds_install_command() {
        let deb = Path::new("/home/u/.cache/gitbolt/updates/GitBolt_0.3.0_amd64.deb");
        let c = install_command(InstallKind::Deb, deb, None).unwrap();
        assert_eq!(c.display(), "pkexec apt install -y /home/u/.cache/gitbolt/updates/GitBolt_0.3.0_amd64.deb", "absolute: pkexec doesn't keep the working directory");
        assert_eq!(c.cwd, None);
        assert!(install_command(InstallKind::Deb, Path::new("GitBolt_0.3.0_amd64.deb"), None).is_none(), "apt would read a bare name as a package name");
        assert_eq!(manual_command(InstallKind::Deb, deb).unwrap(), "sudo apt install /home/u/.cache/gitbolt/updates/GitBolt_0.3.0_amd64.deb");

        let pkg = Path::new("/home/u/.cache/gitbolt/updates/GitBolt-0.3.0-1-x86_64.pkg.tar.zst");
        let c = install_command(InstallKind::Arch, pkg, None).unwrap();
        assert_eq!((c.program.as_str(), c.args.clone()), ("pkexec", vec!["pacman".to_string(), "-U".into(), "--noconfirm".into(), pkg.display().to_string()]), "GitBolt's: no conflict to answer");
        let volt = Path::new("/home/u/.cache/gitbolt/updates/GitVolt-0.7.0-1-x86_64.pkg.tar.zst");
        let c = install_command(InstallKind::Arch, volt, None).unwrap();
        assert_eq!(c.args, ["pacman", "-U", "--noconfirm", "--ask=4", &volt.display().to_string()], "GitVolt's: yes to removing gitbolt");
        assert_eq!(manual_command(InstallKind::Arch, pkg).unwrap(), "sudo pacman -U /home/u/.cache/gitbolt/updates/GitBolt-0.3.0-1-x86_64.pkg.tar.zst");

        let exe = Path::new(r"C:\Users\u\AppData\Local\gitbolt\updates\GitBolt_0.3.0_x64-setup.exe");
        let c = install_command(InstallKind::Nsis, exe, None).unwrap();
        assert_eq!((c.program.as_str(), c.args.len()), (exe.to_str().unwrap(), 0));
        let msi = Path::new(r"C:\Users\u\AppData\Local\gitbolt\updates\GitBolt_0.3.0_x64.msi");
        let c = install_command(InstallKind::Msi, msi, None).unwrap();
        assert_eq!((c.program.as_str(), c.args.clone()), ("msiexec", vec!["/i".to_string(), msi.to_str().unwrap().into()]));
        assert_eq!(manual_command(InstallKind::Msi, msi), None);
        assert_eq!(install_command(InstallKind::Unpackaged, deb, None), None);

        let dmg = Path::new("/Users/u/Library/Caches/GitBolt/updates/GitBolt_0.3.0_aarch64.dmg");
        let app = Path::new("/Applications/GitBolt.app");
        let c = install_command(InstallKind::Dmg, dmg, Some(app)).unwrap();
        assert_eq!((c.program.as_str(), c.args[1].as_str()), ("/bin/sh", DMG_INSTALL));
        assert_eq!(c.args[2..], ["gitbolt-update".to_string(), dmg.display().to_string(), "/Applications/GitBolt.app".into()], "the paths are arguments, never part of the script");
        assert_eq!(install_command(InstallKind::Dmg, dmg, None), None, "not running from a bundle");
        assert_eq!(manual_command(InstallKind::Dmg, dmg).unwrap(), "open /Users/u/Library/Caches/GitBolt/updates/GitBolt_0.3.0_aarch64.dmg");
    }

    #[test]
    fn an_rpm_installs_with_dnf_else_zypper_else_rpm() {
        let rpm = Path::new("/home/u/.cache/gitbolt/updates/GitBolt-0.3.0-1.x86_64.rpm");
        let f = rpm.display().to_string();
        assert_eq!(RpmTool::pick(|t| t == "dnf" || t == "zypper"), RpmTool::Dnf);
        assert_eq!(RpmTool::pick(|t| t == "zypper"), RpmTool::Zypper);
        assert_eq!(RpmTool::pick(|_| false), RpmTool::Rpm);
        for (tool, args, manual) in [
            (RpmTool::Dnf, vec!["dnf", "install", "-y", &f], format!("sudo dnf install {f}")),
            (RpmTool::Zypper, vec!["zypper", "--non-interactive", "install", "--allow-unsigned-rpm", &f], format!("sudo zypper install --allow-unsigned-rpm {f}")),
            (RpmTool::Rpm, vec!["rpm", "-U", &f], format!("sudo rpm -U {f}")),
        ] {
            let c = rpm_install_command(rpm, tool).unwrap();
            assert_eq!((c.program.as_str(), c.args.clone()), ("pkexec", args.iter().map(|a| a.to_string()).collect()), "{tool:?}: an argument list, the path one argument");
            assert_eq!(c.cwd, None);
            assert_eq!(tool.manual(&quote(&f)), manual);
        }
        assert!(rpm_install_command(Path::new("GitBolt-0.3.0-1.x86_64.rpm"), RpmTool::Dnf).is_none(), "pkexec doesn't keep the working directory");
        // install_command and manual_command take this system's tool.
        let tool = RpmTool::detect();
        assert_eq!(install_command(InstallKind::Rpm, rpm, None), rpm_install_command(rpm, tool));
        assert_eq!(manual_command(InstallKind::Rpm, rpm), Some(tool.manual(&f)));
        let spaced = Path::new("/home/o'neil/my cache/GitBolt-0.3.0-1.x86_64.rpm");
        assert_eq!(RpmTool::Dnf.manual(&quote(&spaced.display().to_string())), r"sudo dnf install '/home/o'\''neil/my cache/GitBolt-0.3.0-1.x86_64.rpm'");
        assert_eq!(rpm_install_command(spaced, RpmTool::Dnf).unwrap().args[3], spaced.display().to_string(), "unquoted: no shell");
    }

    #[test]
    fn finds_the_bundle_the_binary_runs_from() {
        assert_eq!(app_bundle(Path::new("/Applications/GitBolt.app/Contents/MacOS/GitBolt")), Some(PathBuf::from("/Applications/GitBolt.app")));
        assert_eq!(app_bundle(Path::new("/Users/u/Apps/My GitBolt.app/Contents/MacOS/GitBolt")), Some(PathBuf::from("/Users/u/Apps/My GitBolt.app")));
        for not in ["/usr/share/GitBolt/gitbolt", "/x/target/debug/GitBolt", "/x/GitBolt/Contents/MacOS/GitBolt", "/x/GitBolt.app/Contents/Frameworks/GitBolt"] {
            assert_eq!(app_bundle(Path::new(not)), None, "{not}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_bundle_is_replaceable_only_where_this_user_can_write() {
        let dir = tempfile::tempdir().unwrap();
        let app = dir.path().join("GitBolt.app");
        assert!(!bundle_replaceable(&app), "no bundle");
        std::fs::create_dir(&app).unwrap();
        assert!(bundle_replaceable(&app));
        crate::platform::fs::set_mode(dir.path(), 0o555).unwrap();
        let root = nix::unistd::geteuid().is_root();
        assert_eq!(bundle_replaceable(&app), root, "a read-only folder (root writes anyway)");
        crate::platform::fs::set_mode(dir.path(), 0o755).unwrap();
    }

    /// The real install on a real disk image: the old bundle is replaced by the image's, nothing is
    /// left beside it or mounted, and the copy carries no quarantine flag.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_dmg_update_replaces_the_bundle_and_detaches() {
        use std::process::Command;
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("src");
        std::fs::create_dir_all(src.join("GitBolt.app/Contents/MacOS")).unwrap();
        std::fs::write(src.join("GitBolt.app/Contents/MacOS/GitBolt"), "new").unwrap();
        let dmg = dir.path().join("GitBolt_0.3.0_aarch64.dmg");
        let made = Command::new("hdiutil").args(["create", "-quiet", "-fs", "HFS+", "-format", "UDZO", "-volname", "GitBolt", "-srcfolder"]).arg(&src).arg(&dmg).status().unwrap();
        assert!(made.success());
        let apps = dir.path().join("Applications");
        let app = apps.join("GitBolt.app");
        std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
        std::fs::write(app.join("Contents/MacOS/GitBolt"), "old").unwrap();
        std::fs::write(app.join("Contents/stale"), "only in the old one").unwrap();
        assert!(bundle_replaceable(&app));

        let c = install_command(InstallKind::Dmg, &dmg, Some(&app)).unwrap();
        let out = Command::new(&c.program).args(&c.args).env("TMPDIR", dir.path()).output().unwrap();
        assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/GitBolt")).unwrap(), "new");
        assert!(!app.join("Contents/stale").exists(), "replaced, not merged");
        let left: Vec<_> = std::fs::read_dir(&apps).unwrap().map(|e| e.unwrap().file_name()).collect();
        assert_eq!(left, ["GitBolt.app"], "no staging copy left beside it");
        let mounts = String::from_utf8_lossy(&Command::new("hdiutil").arg("info").output().unwrap().stdout).into_owned();
        assert!(!mounts.contains("gitbolt-update."), "detached: {mounts}");
        assert!(!std::fs::read_dir(dir.path()).unwrap().any(|e| e.unwrap().file_name().to_string_lossy().starts_with("gitbolt-update.")), "its mount point removed");
        let xattrs = Command::new("xattr").arg("-r").arg(&app).output().unwrap();
        let xattrs = String::from_utf8_lossy(&xattrs.stdout);
        println!("xattr -r of the installed bundle: {xattrs:?}");
        assert!(!xattrs.contains("com.apple.quarantine"), "{xattrs}");

        // A broken image leaves the installed bundle as it was.
        std::fs::write(&dmg, "not a disk image").unwrap();
        let out = Command::new(&c.program).args(&c.args).env("TMPDIR", dir.path()).output().unwrap();
        assert!(!out.status.success());
        assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/GitBolt")).unwrap(), "new");
    }

    /// A temporary folder with "gitbolt" in its path, as a user's or `TMPDIR` may have: only the
    /// install's own names may change.
    fn gitbolt_tempdir() -> tempfile::TempDir {
        tempfile::Builder::new().prefix("gitbolt-tmp").tempdir().unwrap()
    }

    /// The script's own steps on any unix, `hdiutil` and `ditto` stood in for (the image is a
    /// folder): which app it takes from the image, where it puts it, what it leaves, what Restart
    /// then starts and removes; and a failed swap puts the bundle back.
    #[cfg(unix)]
    #[test]
    fn a_dmg_update_takes_the_images_gitvolt_or_gitbolt_app() {
        let dir = gitbolt_tempdir();
        let bin = dir.path().join("bin");
        let failing = dir.path().join("failing-mv");
        std::fs::create_dir(&bin).unwrap();
        std::fs::create_dir(&failing).unwrap();
        // `attach … -mountpoint <mnt> <image>`: the image folder's contents copied into <mnt>.
        let hdiutil = "#!/bin/sh\n[ \"$1\" = attach ] || exit 0\nfor a; do last=$a; done\nwhile [ \"$1\" != -mountpoint ]; do shift; done\ncp -R \"$last\"/. \"$2\"\n";
        // A `mv` that can't move the new copy into place.
        let mv = "#!/bin/sh\ncase \"$1\" in *.new.*) echo \"mv: refused\" >&2; exit 1;; esac\nexec /bin/mv \"$@\"\n";
        for (at, body) in [(bin.join("hdiutil"), hdiutil), (bin.join("ditto"), "#!/bin/sh\ncp -R \"$1\" \"$2\"\n"), (failing.join("mv"), mv)] {
            std::fs::write(&at, body).unwrap();
            crate::platform::fs::set_mode(&at, 0o755).unwrap();
        }
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        let path_failing = format!("{}:{path}", failing.display());
        let bundle = |at: &Path, binary: &str, text: &str| {
            std::fs::create_dir_all(at.join("Contents/MacOS")).unwrap();
            std::fs::write(at.join("Contents/MacOS").join(binary), text).unwrap();
        };
        let listing = |d: &Path| {
            let mut v: Vec<String> = std::fs::read_dir(d).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
            v.sort();
            v
        };
        /// The running bundle, bundles already there, the image's apps, the folder after, what
        /// Restart starts (none: the install fails), whether Restart removes the old bundle.
        type Case = (&'static str, &'static [&'static str], &'static [&'static str], &'static [&'static str], Option<&'static str>, bool);
        let cases: [Case; 5] = [
            ("GitBolt.app", &[], &["GitVolt.app", "GitBolt.app"], &["GitBolt.app", "GitVolt.app"], Some("GitVolt.app/Contents/MacOS/GitVolt"), true),
            ("GitBolt.app", &[], &["GitBolt.app"], &["GitBolt.app"], Some("GitBolt.app/Contents/MacOS/GitBolt"), false),
            ("GitBolt.app", &["GitVolt.app"], &["GitVolt.app"], &["GitBolt.app", "GitVolt.app"], Some("GitVolt.app/Contents/MacOS/GitVolt"), true),
            ("My GitBolt.app", &[], &["GitVolt.app"], &["My GitBolt.app"], Some("My GitBolt.app/Contents/MacOS/GitVolt"), false),
            ("GitBolt.app", &[], &["Other.app"], &["GitBolt.app"], None, false),
        ];
        for (i, (running, there, image, after, restart, retires)) in cases.into_iter().enumerate() {
            let apps = dir.path().join(format!("gitbolt/Applications{i}"));
            let app = apps.join(running);
            bundle(&app, "GitBolt", "old");
            for b in there {
                bundle(&apps.join(b), "GitVolt", "stale");
            }
            let img = dir.path().join(format!("image{i}"));
            for b in image {
                bundle(&img.join(b), &b.replace(".app", ""), b);
            }
            let c = install_command(InstallKind::Dmg, &img, Some(&app)).unwrap();
            if restart.is_some() {
                // The swap fails: the bundles are as they were, and nothing is left beside them.
                let out = std::process::Command::new(&c.program).args(&c.args).env("PATH", &path_failing).env("TMPDIR", dir.path()).output().unwrap();
                assert!(!out.status.success() && String::from_utf8_lossy(&out.stderr).contains("mv: refused"), "{i}");
                let mut before: Vec<String> = [running].iter().chain(there).map(|s| s.to_string()).collect();
                before.sort();
                assert_eq!(listing(&apps), before, "{i}: restored");
                assert_eq!(std::fs::read_to_string(app.join("Contents/MacOS/GitBolt")).unwrap(), "old", "{i}");
                for b in there {
                    assert_eq!(std::fs::read_to_string(apps.join(b).join("Contents/MacOS/GitVolt")).unwrap(), "stale", "{i}");
                }
            }
            let out = std::process::Command::new(&c.program).args(&c.args).env("PATH", &path).env("TMPDIR", dir.path()).output().unwrap();
            let stderr = String::from_utf8_lossy(&out.stderr);
            assert_eq!(out.status.success(), restart.is_some(), "{i}: {stderr}");
            assert_eq!(listing(&apps), after.iter().map(|s| s.to_string()).collect::<Vec<_>>(), "{i}: no staging copy left");
            let running_exe = app.join("Contents/MacOS/GitBolt");
            let exe = relaunch_target(&running_exe, image[0] == "GitVolt.app");
            match restart {
                Some(want) => {
                    assert_eq!(exe, apps.join(want), "{i}");
                    assert_eq!(std::fs::read_to_string(&exe).unwrap(), image[0], "{i}: the image's first app");
                    assert_eq!(retired_bundle(&running_exe, &exe), retires.then(|| app.clone()), "{i}");
                }
                None => {
                    assert_eq!(stderr.trim(), "The disk image has no GitVolt.app or GitBolt.app.");
                    assert_eq!(std::fs::read_to_string(&exe).unwrap(), "old", "left as it was");
                }
            }
        }
    }

    #[test]
    fn restart_finds_the_binary_under_the_new_name_within_the_install_only() {
        let dir = gitbolt_tempdir();
        let root = dir.path().join("gitbolt");
        for old in [root.join("usr/share/GitBolt/gitbolt"), root.join("usr/bin/gitbolt")] {
            assert!(renamed_binaries(&old).iter().all(|p| p.starts_with(old.parent().unwrap().parent().unwrap())), "{old:?}");
            assert_eq!(relaunch_target(&old, true), old, "nothing there: as it was");
        }
        let old = root.join("usr/share/GitBolt/gitbolt");
        let new = root.join("usr/share/GitVolt/gitvolt");
        assert_eq!(renamed_binaries(&old), [new.clone(), root.join("usr/share/GitVolt/gitbolt"), root.join("usr/share/GitBolt/gitvolt")]);
        std::fs::create_dir_all(new.parent().unwrap()).unwrap();
        std::fs::write(&new, "").unwrap();
        assert_eq!(relaunch_target(&old, false), new, "the old one is gone");
        std::fs::create_dir_all(old.parent().unwrap()).unwrap();
        std::fs::write(&old, "").unwrap();
        assert_eq!(relaunch_target(&old, false), old, "a GitBolt update: the same binary");
        assert_eq!(relaunch_target(&old, true), new, "an update into GitVolt: its binary, though the old one is there");
        assert_eq!(renamed_binaries(&root.join("usr/bin/gitbolt")), [root.join("usr/bin/gitvolt")], "`bin` has no old name");

        // A bundle: GitBolt.app → GitVolt.app beside it, whatever the folders above are called.
        let app = root.join("Applications/GitBolt.app/Contents/MacOS/GitBolt");
        let gitvolt = root.join("Applications/GitVolt.app/Contents/MacOS");
        assert_eq!(renamed_binaries(&app), [gitvolt.join("GitVolt"), gitvolt.join("GitBolt"), app.with_file_name("GitVolt")]);
        std::fs::create_dir_all(&gitvolt).unwrap();
        std::fs::write(gitvolt.join("GitBolt"), "").unwrap();
        assert_eq!(relaunch_target(&app, true), gitvolt.join("GitBolt"), "the bundle renamed, its binary not");
        assert_eq!(retired_bundle(&app, &gitvolt.join("GitBolt")), Some(root.join("Applications/GitBolt.app")));
        assert_eq!(retired_bundle(&app, &app), None);
        let mine = root.join("Applications/My GitBolt.app/Contents/MacOS/GitBolt");
        assert_eq!(renamed_binaries(&mine), [mine.with_file_name("GitVolt")], "a bundle of the user's naming keeps it");
        assert_eq!(retired_bundle(&mine, &gitvolt.join("GitBolt")), None);
    }

    #[test]
    fn a_path_with_spaces_or_quotes_is_quoted_for_the_shell() {
        let f = Path::new("/home/o'neil/my cache/GitBolt_0.3.0_amd64.deb");
        assert_eq!(manual_command(InstallKind::Deb, f).unwrap(), r"sudo apt install '/home/o'\''neil/my cache/GitBolt_0.3.0_amd64.deb'");
    }

    #[test]
    fn relaunch_waits_for_this_process_then_starts_the_installed_binary() {
        let c = relaunch_command(Path::new("/usr/share/GitBolt/gitbolt"), 4242, None);
        assert_eq!(c.program, "/bin/sh");
        assert_eq!(c.args[2..], ["gitbolt-relaunch".to_string(), "4242".into(), "/usr/share/GitBolt/gitbolt".into(), String::new()]);
        // The script waits for the pid, then execs the binary; neither is spliced into it.
        assert!(c.args[1].contains(r#"kill -0 "$1""#) && c.args[1].ends_with(r#"exec "$2""#));
        let retire = Path::new("/Applications/GitBolt.app");
        assert_eq!(relaunch_command(Path::new("/Applications/GitVolt.app/Contents/MacOS/GitVolt"), 4242, Some(retire)).args[5], "/Applications/GitBolt.app", "an argument, never part of the script");
        #[cfg(unix)]
        {
            let out = std::process::Command::new(&c.program).args(&c.args[..2]).args(["x", "999999999", "true", ""]).output().unwrap();
            assert!(out.status.success());
            // Then the old bundle goes, before the new one starts.
            let dir = tempfile::tempdir().unwrap();
            let old = dir.path().join("GitBolt.app");
            std::fs::create_dir_all(old.join("Contents/MacOS")).unwrap();
            let out = std::process::Command::new(&c.program).args(&c.args[..2]).args(["x", "999999999", "true"]).arg(&old).output().unwrap();
            assert!(out.status.success());
            assert!(!old.exists());
        }
    }
}
