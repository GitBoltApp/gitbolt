//! "Open in default app" (and "Open in browser" for an HTML file, the same thing): the file in
//! whatever the OS opens it with on a double click. On Linux `xdg-open` (else `gio open`), or,
//! inside a Flatpak or Snap sandbox, xdg-desktop-portal's `OpenURI.OpenFile` (the file as a
//! read-only descriptor); on macOS `open`; on Windows the shell's default verb (`ShellExecuteW`).
//! As for every opener, the file is an absolute path the API has checked, passed as its own
//! argument and never through a shell.
//!
//! Never runs a repository's file (SECURITY.md): a file the OS would execute or launch rather
//! than open (`runs_as_program`: a launcher or script by its name, an executable by its mode on
//! Unix, a dangerous type by the shell's own list on Windows) is refused before anything starts.

use super::{find_in_path, LaunchCommand};
use crate::error::{GbError, GbErrorKind};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Opens an absolute file path the API has checked in its default application.
pub type DefaultApp = Arc<dyn Fn(&Path) -> Result<(), GbError> + Send + Sync>;

/// Why a file isn't opened in its default app; the UI shows the same reason on the row.
pub const RUNS_AS_PROGRAM: &str = "Runs as a program: open it in an editor, or use Other…";

/// Extensions whose default handler runs or launches the file instead of showing it, refused on
/// every OS: Windows's executables, scripts and shortcuts (Wine opens them on Linux too), and
/// Unix desktops' and macOS's launchers and scripts. Lowercase, without the dot.
pub const PROGRAM_EXTENSIONS: &[&str] = &[
    // Windows
    "exe", "bat", "cmd", "com", "scr", "vbs", "vbe", "js", "jse", "wsf", "wsh", "hta", "msi", "msp", "cpl", "lnk", "url", "reg", "jar", "ps1", "psm1", "scf", "pif",
    "application", "appref-ms",
    // Unix desktops and macOS
    "desktop", "sh", "bash", "zsh", "command", "tool", "terminal", "app", "appimage", "run", "fileloc", "inetloc", "webloc", "scpt", "applescript", "workflow",
];

/// The OSes with a default-app launch. On Linux, whether GitVolt runs in a Flatpak or Snap
/// sandbox, where only the portal can reach the host's apps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Os {
    Linux { sandboxed: bool },
    MacOs,
    Windows,
}

/// `name`'s extension as Windows reads it (trailing dots and spaces dropped), lowercased.
fn extension(name: &Path) -> Option<String> {
    let name = name.file_name()?.to_string_lossy();
    let (_, ext) = name.trim_end_matches(['.', ' ']).rsplit_once('.')?;
    Some(ext.to_ascii_lowercase()).filter(|e| !e.is_empty())
}

/// Whether `os`'s default handler would run or launch the file shown as `names` (its path in the
/// repository, and what it resolves to on disk) rather than open it: an extension on
/// `PROGRAM_EXTENSIONS`; on Unix, any execute bit in `mode` (the file's, symlinks followed); on
/// Windows, a type the shell itself calls dangerous (`assoc_dangerous`, given `.ext`).
pub fn runs_as_program(os: Os, names: &[&Path], mode: Option<u32>, assoc_dangerous: &dyn Fn(&str) -> bool) -> bool {
    let exts: Vec<String> = names.iter().filter_map(|n| extension(n)).collect();
    if exts.iter().any(|e| PROGRAM_EXTENSIONS.contains(&e.as_str())) {
        return true;
    }
    match os {
        Os::Windows => exts.iter().any(|e| assoc_dangerous(&format!(".{e}"))),
        Os::Linux { .. } | Os::MacOs => mode.is_some_and(|m| m & 0o111 != 0),
    }
}

/// This machine's OS, as `launch_for` and `runs_as_program` take it.
pub fn this_os() -> Os {
    #[cfg(windows)]
    return Os::Windows;
    #[cfg(target_os = "macos")]
    return Os::MacOs;
    #[cfg(not(any(windows, target_os = "macos")))]
    Os::Linux { sandboxed: sandboxed(|v| std::env::var_os(v).is_some(), Path::new("/.flatpak-info").exists()) }
}

/// Inside a Flatpak (`FLATPAK_ID`, `/.flatpak-info`) or a Snap (`SNAP`).
pub fn sandboxed(var_set: impl Fn(&str) -> bool, flatpak_info: bool) -> bool {
    flatpak_info || var_set("FLATPAK_ID") || var_set("SNAP")
}

/// Refuses `target` (the file about to be opened; `shown` its repository path) when this OS
/// would run it (`runs_as_program`), checked on what it resolves to.
pub fn check_not_a_program(shown: &Path, target: &Path) -> Result<(), GbError> {
    let real = crate::platform::fs::canonicalize(target).map_err(|_| GbError::new(GbErrorKind::NotFound, format!("{} isn't there", shown.display())))?;
    #[cfg(unix)]
    let mode = std::fs::metadata(&real).ok().map(|m| crate::platform::fs::mode(&m));
    #[cfg(not(unix))]
    let mode = None;
    #[cfg(windows)]
    let dangerous = super::win32::assoc_is_dangerous;
    #[cfg(not(windows))]
    let dangerous = |_: &str| false;
    if runs_as_program(this_os(), &[shown, &real], mode, &dangerous) {
        return Err(GbError::new(GbErrorKind::InvalidInput, RUNS_AS_PROGRAM));
    }
    Ok(())
}

/// How `Os` opens one file in its default application.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Launch {
    /// Linux in a sandbox: the OpenURI portal, else `fallback` (`xdg-open`/`gio open`) when the
    /// portal isn't there at all.
    Portal { file: PathBuf, fallback: Option<LaunchCommand> },
    /// `xdg-open <file>` / `gio open <file>`, `open <file>`: detached like an opener.
    Command(LaunchCommand),
    /// Windows: the shell's default verb on the file.
    ShellOpen(PathBuf),
}

/// What `os` runs to open `file`; `path` is `$PATH`, where Linux finds `xdg-open` or `gio`.
pub fn launch_for(os: Os, file: &Path, path: &[PathBuf]) -> Result<Launch, GbError> {
    let file = file.to_path_buf();
    let host = || {
        find_in_path(path, "xdg-open")
            .map(|program| LaunchCommand { program, args: vec![file.clone().into()] })
            .or_else(|| find_in_path(path, "gio").map(|program| LaunchCommand { program, args: vec!["open".into(), file.clone().into()] }))
    };
    Ok(match os {
        Os::Linux { sandboxed: true } => Launch::Portal { fallback: host(), file },
        Os::Linux { sandboxed: false } => Launch::Command(host().ok_or_else(|| GbError::new(GbErrorKind::NotFound, "neither xdg-open nor gio is available"))?),
        Os::MacOs => Launch::Command(LaunchCommand { program: "/usr/bin/open".into(), args: vec![file.into()] }),
        Os::Windows => Launch::ShellOpen(file),
    })
}

/// How the portal answered an `OpenFile`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortalReply {
    Opened,
    /// No portal to ask: no session bus, no such service or interface, or the connection gone.
    Absent(String),
    /// The portal answered with an error (it refused, or the file couldn't be passed).
    Refused(String),
    /// No answer in time: the request may still go through.
    TimedOut,
}

/// Runs `launch`. A portal that isn't there falls back to the host command; one that refuses
/// is the answer (an error), and one that times out isn't followed by a second open.
pub fn run(
    launch: Launch,
    portal: impl FnOnce(&Path) -> PortalReply,
    spawn: impl FnOnce(&LaunchCommand) -> Result<(), GbError>,
    shell_open: impl FnOnce(&Path) -> Result<(), GbError>,
) -> Result<(), GbError> {
    match launch {
        Launch::Portal { file, fallback } => match portal(&file) {
            PortalReply::Opened => Ok(()),
            PortalReply::TimedOut => {
                tracing::warn!("the OpenURI portal for {} didn't answer in time; not opening it a second way", file.display());
                Ok(())
            }
            PortalReply::Refused(why) => Err(GbError::other(format!("couldn't open {}: {why}", file.display()))),
            PortalReply::Absent(why) => {
                tracing::warn!("the OpenURI portal isn't available ({why}); opening {} on the host instead", file.display());
                fallback.as_ref().map_or_else(|| Err(GbError::new(GbErrorKind::NotFound, "neither the OpenURI portal nor xdg-open is available")), spawn)
            }
        },
        Launch::Command(cmd) => spawn(&cmd),
        Launch::ShellOpen(file) => shell_open(&file),
    }
}

/// D-Bus errors that mean the portal (or its OpenURI interface) isn't there, rather than that it
/// refused.
pub fn is_absent_error(name: &str) -> bool {
    matches!(
        name,
        "org.freedesktop.DBus.Error.ServiceUnknown" | "org.freedesktop.DBus.Error.NameHasNoOwner" | "org.freedesktop.DBus.Error.UnknownInterface" | "org.freedesktop.DBus.Error.UnknownMethod" | "org.freedesktop.DBus.Error.UnknownObject"
    )
}

/// This OS's default-app opener, or `None` where there's none. `hook` adjusts a spawned
/// command's environment, as for every launch (`ChildEnvHook`).
pub fn system_default_app(hook: super::ChildEnvHook) -> Option<DefaultApp> {
    let spawn = move |c: &LaunchCommand| super::spawn_detached_with(c, &*hook);
    let no_shell = |_: &Path| -> Result<(), GbError> { Err(GbError::other("no shell verb here")) };
    #[cfg(target_os = "linux")]
    return Some(Arc::new(move |f: &Path| {
        let path: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).filter(|d| d.is_absolute()).collect()).unwrap_or_default();
        run(launch_for(this_os(), f, &path)?, linux::portal_open_file, &spawn, no_shell)
    }));
    #[cfg(target_os = "macos")]
    return Some(Arc::new(move |f: &Path| run(launch_for(Os::MacOs, f, &[])?, |_| PortalReply::Absent("no portal here".into()), &spawn, no_shell)));
    // The shell starts the handler, so there's no command for `hook` to adjust.
    #[cfg(windows)]
    {
        let _ = (spawn, no_shell);
        Some(Arc::new(move |f: &Path| run(launch_for(Os::Windows, f, &[])?, |_| PortalReply::Absent("no portal here".into()), |_| Err(GbError::other("no command here")), super::win32::open_file)))
    }
    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = (spawn, no_shell);
        None
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::super::chooser::{linux as chooser_linux, with_timeout, PortalError};
    use super::{is_absent_error, PortalReply};
    use std::collections::HashMap;
    use std::path::Path;
    use zbus::zvariant::{Fd, Value};

    /// `OpenURI.OpenFile("", fd, {writable: false})` on the shared session bus (no chooser).
    pub(super) fn portal_open_file(file: &Path) -> PortalReply {
        let f = match std::fs::File::open(file) {
            Ok(f) => f,
            Err(e) => return PortalReply::Refused(e.to_string()),
        };
        let bus = match chooser_linux::shared_bus() {
            Ok(bus) => bus,
            Err(e) => return PortalReply::Absent(e.to_string()),
        };
        let reply = with_timeout(
            move || {
                let options: HashMap<&str, Value<'_>> = HashMap::from([("writable", Value::from(false))]);
                Ok(match bus.call_method(Some("org.freedesktop.portal.Desktop"), "/org/freedesktop/portal/desktop", Some("org.freedesktop.portal.OpenURI"), "OpenFile", &("", Fd::from(&f), options)) {
                    Ok(_) => PortalReply::Opened,
                    Err(e) => classify(e),
                })
            },
            chooser_linux::CALL_TIMEOUT,
        );
        reply.unwrap_or(PortalReply::TimedOut)
    }

    fn classify(e: zbus::Error) -> PortalReply {
        let absent = match &e {
            zbus::Error::MethodError(name, _, _) => is_absent_error(name.as_str()),
            zbus::Error::FDO(f) => matches!(**f, zbus::fdo::Error::ServiceUnknown(_) | zbus::fdo::Error::NameHasNoOwner(_) | zbus::fdo::Error::UnknownInterface(_) | zbus::fdo::Error::UnknownMethod(_) | zbus::fdo::Error::UnknownObject(_)),
            _ => false,
        };
        if absent {
            return PortalReply::Absent(e.to_string());
        }
        match chooser_linux::classify_zbus_error(e) {
            why @ PortalError::Disconnected(_) => {
                chooser_linux::forget_bus_on_disconnect(&why);
                PortalReply::Absent(why.to_string())
            }
            why => PortalReply::Refused(why.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    fn argv(c: &LaunchCommand) -> Vec<String> {
        std::iter::once(c.program.to_string_lossy().into_owned()).chain(c.args.iter().map(|a| a.to_string_lossy().into_owned())).collect()
    }

    const LINUX: Os = Os::Linux { sandboxed: false };
    const FLATPAK: Os = Os::Linux { sandboxed: true };

    /// What each OS runs, the file always its own whole argument (a space, a leading dash in
    /// the name, a `$` stay inside it).
    #[cfg(unix)] // executable `xdg-open` and `gio` (Windows's would end in .exe)
    #[test]
    fn each_os_opens_the_file_as_one_argument() {
        let file = Path::new("/w/docs/-a $b.html");
        let tmp = tempfile::tempdir().unwrap();
        let (xdg_dir, gio_dir) = (tmp.path().join("x"), tmp.path().join("g"));
        let xdg = super::super::tests::executable(&xdg_dir.join("xdg-open"));
        let gio = super::super::tests::executable(&gio_dir.join("gio"));
        let Launch::Command(cmd) = launch_for(LINUX, file, &[xdg_dir.clone(), gio_dir.clone()]).unwrap() else { panic!("xdg-open on the host") };
        assert_eq!(argv(&cmd), [xdg.to_string_lossy().into_owned(), "/w/docs/-a $b.html".into()]);
        let Launch::Command(cmd) = launch_for(LINUX, file, std::slice::from_ref(&gio_dir)).unwrap() else { panic!("gio open without xdg-open") };
        assert_eq!(argv(&cmd), [gio.to_string_lossy().into_owned(), "open".into(), "/w/docs/-a $b.html".into()]);
        assert_eq!(launch_for(LINUX, file, &[]).unwrap_err().kind, GbErrorKind::NotFound);
        let Launch::Portal { file: f, fallback: Some(cmd) } = launch_for(FLATPAK, file, &[xdg_dir]).unwrap() else { panic!("the portal in a sandbox") };
        assert_eq!(f, file);
        assert_eq!(argv(&cmd)[0], xdg.to_string_lossy());
        assert_eq!(launch_for(FLATPAK, file, &[]).unwrap(), Launch::Portal { file: file.into(), fallback: None });
        let Launch::Command(cmd) = launch_for(Os::MacOs, file, &[]).unwrap() else { panic!("macOS runs open") };
        assert_eq!(argv(&cmd), ["/usr/bin/open", "/w/docs/-a $b.html"]);
        assert_eq!(launch_for(Os::Windows, file, &[]).unwrap(), Launch::ShellOpen(file.into()));
    }

    #[test]
    fn a_flatpak_or_a_snap_is_a_sandbox() {
        assert!(!sandboxed(|_| false, false));
        assert!(sandboxed(|_| false, true));
        assert!(sandboxed(|v| v == "FLATPAK_ID", false));
        assert!(sandboxed(|v| v == "SNAP", false));
        assert!(is_absent_error("org.freedesktop.DBus.Error.ServiceUnknown"));
        assert!(!is_absent_error("org.freedesktop.portal.Error.NotAllowed"));
    }

    /// In a sandbox the portal opens the file; `xdg-open` only when there's no portal, never
    /// after a refusal or a timeout.
    #[test]
    fn the_portal_falls_back_only_when_it_isnt_there() {
        let fallback = LaunchCommand { program: "/usr/bin/xdg-open".into(), args: vec!["/w/a.png".into()] };
        let launch = || Launch::Portal { file: "/w/a.png".into(), fallback: Some(fallback.clone()) };
        let spawned = RefCell::new(Vec::new());
        let spawn = |c: &LaunchCommand| {
            spawned.borrow_mut().push(argv(c));
            Ok(())
        };
        let asked = RefCell::new(None);
        run(launch(), |f| { *asked.borrow_mut() = Some(f.to_path_buf()); PortalReply::Opened }, spawn, |_| unreachable!()).unwrap();
        assert_eq!(asked.into_inner().as_deref(), Some(Path::new("/w/a.png")));
        run(launch(), |_| PortalReply::TimedOut, spawn, |_| unreachable!()).unwrap();
        assert!(run(launch(), |_| PortalReply::Refused("org.freedesktop.portal.Error.NotAllowed".into()), spawn, |_| unreachable!()).is_err());
        assert!(spawned.borrow().is_empty(), "no fallback after an answer, a timeout or a refusal");
        run(launch(), |_| PortalReply::Absent("org.freedesktop.DBus.Error.ServiceUnknown".into()), spawn, |_| unreachable!()).unwrap();
        assert_eq!(*spawned.borrow(), [["/usr/bin/xdg-open", "/w/a.png"]]);
        let none = Launch::Portal { file: "/w/a.png".into(), fallback: None };
        assert_eq!(run(none, |_| PortalReply::Absent("no bus".into()), spawn, |_| unreachable!()).unwrap_err().kind, GbErrorKind::NotFound);
    }

    #[test]
    fn the_host_command_and_the_shell_verb_run_directly() {
        let spawned = RefCell::new(Vec::new());
        let spawn = |c: &LaunchCommand| {
            spawned.borrow_mut().push(argv(c));
            Ok(())
        };
        let cmd = LaunchCommand { program: "/usr/bin/xdg-open".into(), args: vec!["/w/a.pdf".into()] };
        run(Launch::Command(cmd), |_| unreachable!(), spawn, |_| unreachable!()).unwrap();
        run(launch_for(Os::MacOs, Path::new("/w/a.pdf"), &[]).unwrap(), |_| unreachable!(), spawn, |_| unreachable!()).unwrap();
        assert_eq!(*spawned.borrow(), [["/usr/bin/xdg-open", "/w/a.pdf"], ["/usr/bin/open", "/w/a.pdf"]]);
        let shelled = RefCell::new(None);
        run(launch_for(Os::Windows, Path::new(r"C:\w\a.pdf"), &[]).unwrap(), |_| unreachable!(), |_| unreachable!(), |f| { *shelled.borrow_mut() = Some(f.to_path_buf()); Ok(()) }).unwrap();
        assert_eq!(shelled.into_inner().as_deref(), Some(Path::new(r"C:\w\a.pdf")));
    }

    /// The name lists apply everywhere; Unix adds the execute bits, Windows the shell's own list.
    #[test]
    fn a_file_the_os_would_run_is_a_program() {
        let never = |_: &str| false;
        let p = |s: &str| PathBuf::from(s);
        for os in [LINUX, FLATPAK, Os::MacOs, Os::Windows] {
            for name in ["setup.exe", "a/Run.BAT", "x.lnk", "go.desktop", "build.sh", "Tool.command", "app.AppImage", "site.webloc", "evil.exe.", "evil.exe  ", "a.ps1"] {
                assert!(runs_as_program(os, &[&p(name)], Some(0o644), &never), "{os:?} {name}");
            }
            for name in ["readme.md", "index.html", "photo.png", "Makefile", ".bashrc", "a.sh.txt", "exe"] {
                assert!(!runs_as_program(os, &[&p(name)], Some(0o644), &never), "{os:?} {name}");
            }
            // What the shown name resolves to counts too.
            assert!(runs_as_program(os, &[&p("notes.txt"), &p("/w/tools/install.sh")], Some(0o644), &never), "{os:?}");
        }
        // Unix: any execute bit (the target's, symlinks followed).
        for os in [LINUX, Os::MacOs] {
            assert!(runs_as_program(os, &[&p("build")], Some(0o755), &never));
            assert!(runs_as_program(os, &[&p("notes.txt")], Some(0o640 | 0o001), &never));
            assert!(!runs_as_program(os, &[&p("notes.txt")], Some(0o644), &never));
        }
        assert!(!runs_as_program(Os::Windows, &[&p("notes.txt")], Some(0o755), &never), "Windows has no execute bits");
        // Windows: AssocIsDangerous, asked with the dot.
        let asked = RefCell::new(Vec::new());
        let shell = |e: &str| {
            asked.borrow_mut().push(e.to_string());
            e == ".xbap"
        };
        assert!(runs_as_program(Os::Windows, &[&p("a.XBAP")], None, &shell));
        assert!(!runs_as_program(Os::Windows, &[&p("a.txt")], None, &shell));
        assert!(!runs_as_program(LINUX, &[&p("a.xbap")], Some(0o644), &shell), "only Windows asks the shell");
        assert_eq!(*asked.borrow(), [".xbap", ".txt"]);
    }

    #[cfg(unix)]
    #[test]
    fn checking_follows_symlinks_to_the_real_file() {
        use std::os::unix::fs::PermissionsExt;
        let tmp = tempfile::tempdir().unwrap();
        let run = tmp.path().join("run");
        std::fs::write(&run, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o755)).unwrap();
        std::os::unix::fs::symlink(&run, tmp.path().join("notes.txt")).unwrap();
        let err = check_not_a_program(Path::new("notes.txt"), &tmp.path().join("notes.txt")).unwrap_err();
        assert_eq!((err.kind, err.message.as_str()), (GbErrorKind::InvalidInput, RUNS_AS_PROGRAM));
        let plain = tmp.path().join("plain.txt");
        std::fs::write(&plain, "x").unwrap();
        std::fs::set_permissions(&plain, std::fs::Permissions::from_mode(0o644)).unwrap();
        check_not_a_program(Path::new("plain.txt"), &plain).unwrap();
    }
}
