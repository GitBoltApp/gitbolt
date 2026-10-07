//! How this GitBolt was installed, and the commands that install an update over it.
//!
//! Each package says how it was installed in a one-word file beside the binary, `install-kind`,
//! read at run time: one build goes into every package of a platform, so the binary can't know.
//! - Linux: the `.deb` ships `deb` (crates/gitbolt-app/tauri.conf.json) and
//!   `scripts/package-arch.sh` rewrites it to `arch` in the Arch package.
//! - Windows: the NSIS installer writes `nsis` beside `GitBolt.exe` (packaging/windows/gitbolt.nsi),
//!   and the MSI installs a file saying `msi` (gitbolt.wxs).
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
    Nsis,
    Msi,
    /// A build from source: no package to update, only the release page.
    #[serde(rename = "none")]
    Unpackaged,
}

impl InstallKind {
    pub fn parse(s: &str) -> Option<Self> {
        match s.trim() {
            "deb" => Some(Self::Deb),
            "arch" => Some(Self::Arch),
            "nsis" => Some(Self::Nsis),
            "msi" => Some(Self::Msi),
            "none" => Some(Self::Unpackaged),
            _ => None,
        }
    }

    /// Windows installers replace the running app's files, so GitBolt quits once one starts.
    pub fn quits_to_install(self) -> bool {
        matches!(self, Self::Nsis | Self::Msi)
    }
}

/// The install kind: `install-kind` in `exe_dir` (the running binary's folder), else a build from
/// source. An unknown word counts as none.
pub fn detect_install_kind(exe_dir: Option<&Path>) -> InstallKind {
    let file = exe_dir.and_then(|d| std::fs::read_to_string(d.join(INSTALL_KIND_FILE)).ok());
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
/// - arch: `pkexec pacman -U --noconfirm <file>`;
/// - nsis: the installer itself, with its normal UI; msi: `msiexec /i <file>` (UAC asks);
/// - none for a build from source.
pub fn install_command(kind: InstallKind, file: &Path) -> Option<InstallCommand> {
    file.file_name()?;
    match kind {
        InstallKind::Deb if file.is_absolute() => Some(InstallCommand::new("pkexec", &["apt", "install", "-y", &text(file)])),
        InstallKind::Deb => None,
        InstallKind::Arch => Some(InstallCommand::new("pkexec", &["pacman", "-U", "--noconfirm", &text(file)])),
        InstallKind::Nsis => Some(InstallCommand::new(&text(file), &[])),
        InstallKind::Msi => Some(InstallCommand::new("msiexec", &["/i", &text(file)])),
        InstallKind::Unpackaged => None,
    }
}

/// The command to run by hand when the privileged one couldn't (no `pkexec`, the password
/// prompt was cancelled): `sudo apt install <file>`, `sudo pacman -U <file>`. Absolute paths, so
/// it works from any folder.
pub fn manual_command(kind: InstallKind, file: &Path) -> Option<String> {
    let f = quote(&text(file));
    match kind {
        InstallKind::Deb => Some(format!("sudo apt install {f}")),
        InstallKind::Arch => Some(format!("sudo pacman -U {f}")),
        _ => None,
    }
}

/// Starts `exe` again once process `pid` (this one) has exited: the single-instance guard is
/// free by then, so the new version starts on its own instead of handing over to the old one.
/// `exe` and `pid` are arguments to the script, never part of it.
pub fn relaunch_command(exe: &Path, pid: u32) -> InstallCommand {
    InstallCommand::new("/bin/sh", &["-c", r#"while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec "$2""#, "gitbolt-relaunch", &pid.to_string(), &text(exe)])
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
        for (text, kind) in [("deb\n", InstallKind::Deb), ("arch\n", InstallKind::Arch), ("nsis\r\n", InstallKind::Nsis), ("msi\n", InstallKind::Msi), ("msi", InstallKind::Msi), ("snap", InstallKind::Unpackaged), ("", InstallKind::Unpackaged)] {
            std::fs::write(dir.path().join(INSTALL_KIND_FILE), text).unwrap();
            assert_eq!(detect_install_kind(Some(dir.path())), kind, "{text:?}");
        }
        // The files the packaging ships, as they are in the repository.
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../..");
        for (file, kind) in [("crates/gitbolt-app/packaging/install-kind-deb", InstallKind::Deb), ("packaging/windows/install-kind-msi", InstallKind::Msi)] {
            let text = std::fs::read_to_string(repo.join(file)).unwrap();
            assert_eq!(InstallKind::parse(&text), Some(kind), "{file}");
        }
        assert_eq!(serde_json::to_value(InstallKind::Unpackaged).unwrap(), "none");
    }

    #[test]
    fn builds_each_kinds_install_command() {
        let deb = Path::new("/home/u/.cache/gitbolt/updates/GitBolt_0.3.0_amd64.deb");
        let c = install_command(InstallKind::Deb, deb).unwrap();
        assert_eq!(c.display(), "pkexec apt install -y /home/u/.cache/gitbolt/updates/GitBolt_0.3.0_amd64.deb", "absolute: pkexec doesn't keep the working directory");
        assert_eq!(c.cwd, None);
        assert!(install_command(InstallKind::Deb, Path::new("GitBolt_0.3.0_amd64.deb")).is_none(), "apt would read a bare name as a package name");
        assert_eq!(manual_command(InstallKind::Deb, deb).unwrap(), "sudo apt install /home/u/.cache/gitbolt/updates/GitBolt_0.3.0_amd64.deb");

        let pkg = Path::new("/home/u/.cache/gitbolt/updates/GitBolt-0.3.0-1-x86_64.pkg.tar.zst");
        let c = install_command(InstallKind::Arch, pkg).unwrap();
        assert_eq!((c.program.as_str(), c.args.clone()), ("pkexec", vec!["pacman".to_string(), "-U".into(), "--noconfirm".into(), pkg.display().to_string()]));
        assert_eq!(manual_command(InstallKind::Arch, pkg).unwrap(), "sudo pacman -U /home/u/.cache/gitbolt/updates/GitBolt-0.3.0-1-x86_64.pkg.tar.zst");

        let exe = Path::new(r"C:\Users\u\AppData\Local\gitbolt\updates\GitBolt_0.3.0_x64-setup.exe");
        let c = install_command(InstallKind::Nsis, exe).unwrap();
        assert_eq!((c.program.as_str(), c.args.len()), (exe.to_str().unwrap(), 0));
        let msi = Path::new(r"C:\Users\u\AppData\Local\gitbolt\updates\GitBolt_0.3.0_x64.msi");
        let c = install_command(InstallKind::Msi, msi).unwrap();
        assert_eq!((c.program.as_str(), c.args.clone()), ("msiexec", vec!["/i".to_string(), msi.to_str().unwrap().into()]));
        assert_eq!(manual_command(InstallKind::Msi, msi), None);
        assert_eq!(install_command(InstallKind::Unpackaged, deb), None);
    }

    #[test]
    fn a_path_with_spaces_or_quotes_is_quoted_for_the_shell() {
        let f = Path::new("/home/o'neil/my cache/GitBolt_0.3.0_amd64.deb");
        assert_eq!(manual_command(InstallKind::Deb, f).unwrap(), r"sudo apt install '/home/o'\''neil/my cache/GitBolt_0.3.0_amd64.deb'");
    }

    #[test]
    fn relaunch_waits_for_this_process_then_starts_the_installed_binary() {
        let c = relaunch_command(Path::new("/usr/share/GitBolt/gitbolt"), 4242);
        assert_eq!(c.program, "/bin/sh");
        assert_eq!(c.args[2..], ["gitbolt-relaunch".to_string(), "4242".into(), "/usr/share/GitBolt/gitbolt".into()]);
        // The script waits for the pid, then execs the binary; neither is spliced into it.
        assert!(c.args[1].contains(r#"kill -0 "$1""#) && c.args[1].ends_with(r#"exec "$2""#));
        #[cfg(unix)]
        let out = std::process::Command::new(&c.program).args(&c.args[..2]).args(["x", "999999999", "/bin/true"]).output().unwrap();
        #[cfg(unix)]
        assert!(out.status.success());
    }
}
