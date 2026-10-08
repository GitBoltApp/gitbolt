//! "Open in…" on macOS: the editors and IDEs found on `PATH` and as app bundles in
//! `~/Applications` and `/Applications`, JetBrains IDEs through the Toolbox's scripts or their
//! bundles, and Finder (through `open`).
//!
//! An editor with a command-line launcher (VS Code's `bin/code` inside its bundle, Sublime Text's
//! `subl`, Zed's `cli`, a JetBrains IDE's `Contents/MacOS/<name>`) runs it, so it can take a
//! line. One without (TextEdit, BBEdit, Nova) is opened with `open -a <bundle> <file>`.
//!
//! Plain file checks only, so the tests run on any Unix (on fake folders); `MacEnv::from_system`
//! reads the real environment on macOS.

use super::{find_in_path, is_executable, ArgStyle, ExecArg, Opener, OpenerKind, JETBRAINS};
use std::path::{Path, PathBuf};

/// Where detection looks. `from_system` reads the real environment; tests build their own.
pub struct MacEnv {
    /// `$PATH`, in order. An app started from the Dock has only the system's; the login shell's
    /// (Homebrew's `/opt/homebrew/bin`) comes later, so the bundles are looked at too.
    pub path: Vec<PathBuf>,
    pub home: Option<PathBuf>,
    /// Where app bundles are, in order: `~/Applications` (the Toolbox's), `/Applications`, and
    /// `/System/Applications` (TextEdit).
    pub applications: Vec<PathBuf>,
    /// `/usr/bin/open`: Finder, and the editors without a launcher.
    pub open: PathBuf,
}

impl MacEnv {
    #[cfg(target_os = "macos")]
    pub fn from_system() -> Self {
        let path = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).filter(|d| d.is_absolute()).collect()).unwrap_or_default();
        let home = crate::paths::home_dir();
        let applications = home.iter().map(|h| h.join("Applications")).chain(["/Applications".into(), "/System/Applications".into()]).collect();
        Self { path, home, applications, open: "/usr/bin/open".into() }
    }
}

/// `parts` inside the first bundle named `app` (`Visual Studio Code.app`) that has it, as an
/// executable.
fn in_bundle(env: &MacEnv, app: &str, parts: &[&str]) -> Option<PathBuf> {
    env.applications.iter().map(|a| parts.iter().fold(a.join(app), |p, part| p.join(part))).find(|p| is_executable(p))
}

/// The first bundle named `app`.
fn bundle(env: &MacEnv, app: &str) -> Option<PathBuf> {
    env.applications.iter().map(|a| a.join(app)).find(|p| p.join("Contents").is_dir())
}

/// Each JetBrains IDE's launcher inside an app bundle (`PhpStorm.app/Contents/MacOS/phpstorm`),
/// keyed by our launcher name. The bundles' names vary (`IntelliJ IDEA Ultimate.app`, `PyCharm
/// CE.app`), so every `.app` is looked into; the first folder in `applications` wins.
fn jetbrains_bundles(env: &MacEnv) -> Vec<(&'static str, PathBuf)> {
    let mut out: Vec<(&'static str, PathBuf)> = Vec::new();
    for dir in &env.applications {
        let Ok(entries) = std::fs::read_dir(dir) else { continue };
        let mut apps: Vec<PathBuf> = entries.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|e| e == "app")).collect();
        apps.sort();
        for app in apps {
            for (key, _) in JETBRAINS {
                let exe = app.join("Contents").join("MacOS").join(key);
                if !out.iter().any(|(k, _)| k == key) && is_executable(&exe) {
                    out.push((key, exe));
                }
            }
        }
    }
    out
}

/// Every opener found: editors and IDEs (the known ones first, as on Linux), then Finder.
pub fn detect(env: &MacEnv) -> Vec<Opener> {
    let mut found: Vec<Opener> = Vec::new();
    let in_path = |names: &[&str]| names.iter().find_map(|n| find_in_path(&env.path, n));
    let mut add = |id: &str, name: &str, program: Option<PathBuf>, style: ArgStyle| {
        if let Some(p) = program.filter(|_| !found.iter().any(|o| o.id == id)) {
            found.push(Opener::new(id, name, OpenerKind::Editor, p, style));
        }
    };
    fn electron_bin(name: &str) -> [&str; 5] {
        ["Contents", "Resources", "app", "bin", name]
    }
    add("vscode", "VS Code", in_path(&["code"]).or_else(|| in_bundle(env, "Visual Studio Code.app", &electron_bin("code"))), ArgStyle::VsCode);
    add("cursor", "Cursor", in_path(&["cursor"]).or_else(|| in_bundle(env, "Cursor.app", &electron_bin("cursor"))), ArgStyle::VsCode);
    add("vscodium", "VSCodium", in_path(&["codium"]).or_else(|| in_bundle(env, "VSCodium.app", &electron_bin("codium"))), ArgStyle::VsCode);

    // JetBrains: the Toolbox's shell scripts (when enabled), else a launcher on PATH, else the
    // IDE's own bundle.
    let scripts = env.home.as_ref().map(|h| h.join("Library/Application Support/JetBrains/Toolbox/scripts"));
    let bundles = jetbrains_bundles(env);
    for (key, name) in JETBRAINS {
        let script = scripts.as_ref().map(|s| s.join(key)).filter(|p| is_executable(p));
        let from_bundle = || bundles.iter().find(|(k, _)| k == key).map(|(_, exe)| exe.clone());
        add(&format!("jetbrains-{key}"), name, script.or_else(|| in_path(&[key])).or_else(from_bundle), ArgStyle::JetBrains);
    }

    add("sublime", "Sublime Text", in_path(&["subl"]).or_else(|| in_bundle(env, "Sublime Text.app", &["Contents", "SharedSupport", "bin", "subl"])), ArgStyle::PathColonLine);
    add("zed", "Zed", in_path(&["zed"]).or_else(|| in_bundle(env, "Zed.app", &["Contents", "MacOS", "cli"])), ArgStyle::PathColonLine);

    // No launcher: `open -a <bundle> <file>`, no line.
    for (id, name, app) in [("bbedit", "BBEdit", "BBEdit.app"), ("nova", "Nova", "Nova.app"), ("textmate", "TextMate", "TextMate.app"), ("textedit", "TextEdit", "TextEdit.app")] {
        let args = |b: PathBuf| ArgStyle::Exec(vec![ExecArg::Literal("-a".into()), ExecArg::Literal(b.into_os_string()), ExecArg::File]);
        if let Some(b) = bundle(env, app).filter(|_| !found.iter().any(|o| o.id == id)) {
            found.push(Opener::new(id, name, OpenerKind::Editor, env.open.clone(), args(b)));
        }
    }
    found.sort_by_key(super::rank);

    found.push(Opener::new("file-manager", "Finder", OpenerKind::FileManager, env.open.clone(), ArgStyle::FinderReveal));
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openers::tests::{args, executable};

    fn env(root: &Path) -> MacEnv {
        MacEnv {
            path: vec![root.join("bin")],
            home: Some(root.join("home")),
            applications: vec![root.join("home/Applications"), root.join("Applications"), root.join("System/Applications")],
            open: "/usr/bin/open".into(),
        }
    }

    fn app(p: &Path) {
        std::fs::create_dir_all(p.join("Contents")).unwrap();
    }

    fn summary(found: &[Opener]) -> Vec<(&str, &str, PathBuf)> {
        found.iter().map(|o| (o.id.as_str(), o.name.as_str(), o.program().to_path_buf())).collect()
    }

    #[test]
    fn nothing_installed_is_only_finder_revealing_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let found = detect(&env(tmp.path()));
        assert_eq!(summary(&found), [("file-manager", "Finder", PathBuf::from("/usr/bin/open"))]);
        assert_eq!(found[0].kind, OpenerKind::FileManager);
        let shown = found[0].reveal_command(Path::new("/r/src/a b.php")).expect("Finder selects a file");
        assert_eq!(args(&shown), ["-R", "/r/src/a b.php"]);
        assert_eq!(args(&found[0].command(Path::new("/r/src"), Some(3))), ["/r/src"], "a folder just opens");
    }

    #[test]
    fn editors_are_found_on_path_then_in_their_bundles() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        executable(&root.join("bin/code"));
        executable(&root.join("Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"));
        executable(&root.join("home/Applications/Cursor.app/Contents/Resources/app/bin/cursor"));
        executable(&root.join("Applications/Sublime Text.app/Contents/SharedSupport/bin/subl"));
        executable(&root.join("Applications/Zed.app/Contents/MacOS/cli"));
        app(&root.join("Applications/Nova.app"));
        app(&root.join("System/Applications/TextEdit.app"));
        // A bundle without its launcher (a damaged install) isn't an editor.
        app(&root.join("Applications/VSCodium.app"));
        let found = detect(&env(root));
        assert_eq!(summary(&found), [
            ("vscode", "VS Code", root.join("bin/code")),
            ("sublime", "Sublime Text", root.join("Applications/Sublime Text.app/Contents/SharedSupport/bin/subl")),
            ("zed", "Zed", root.join("Applications/Zed.app/Contents/MacOS/cli")),
            ("cursor", "Cursor", root.join("home/Applications/Cursor.app/Contents/Resources/app/bin/cursor")),
            ("nova", "Nova", PathBuf::from("/usr/bin/open")),
            ("textedit", "TextEdit", PathBuf::from("/usr/bin/open")),
            ("file-manager", "Finder", PathBuf::from("/usr/bin/open")),
        ]);
    }

    #[test]
    fn each_editor_keeps_its_file_and_line_arguments() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        executable(&root.join("Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"));
        executable(&root.join("Applications/PhpStorm.app/Contents/MacOS/phpstorm"));
        executable(&root.join("bin/subl"));
        app(&root.join("System/Applications/TextEdit.app"));
        let found = detect(&env(root));
        let open = |id: &str, line| args(&found.iter().find(|o| o.id == id).unwrap().command(Path::new("/r/a b.php"), line));
        assert_eq!(open("vscode", Some(12)), ["-g", "/r/a b.php:12"]);
        assert_eq!(open("jetbrains-phpstorm", Some(7)), ["--line", "7", "/r/a b.php"]);
        assert_eq!(open("sublime", Some(3)), ["/r/a b.php:3"]);
        let textedit = root.join("System/Applications/TextEdit.app").display().to_string();
        assert_eq!(open("textedit", Some(9)), ["-a", textedit.as_str(), "/r/a b.php"], "no line through `open -a`");
    }

    #[test]
    fn jetbrains_ides_come_from_the_toolbox_scripts_then_path_then_their_bundles() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let scripts = root.join("home/Library/Application Support/JetBrains/Toolbox/scripts");
        executable(&scripts.join("phpstorm"));
        executable(&root.join("home/Applications/PhpStorm.app/Contents/MacOS/phpstorm"));
        executable(&root.join("bin/webstorm"));
        executable(&root.join("Applications/WebStorm.app/Contents/MacOS/webstorm"));
        // Bundle names vary; the launcher inside says which IDE it is.
        executable(&root.join("home/Applications/IntelliJ IDEA Ultimate.app/Contents/MacOS/idea"));
        executable(&root.join("Applications/IntelliJ IDEA CE.app/Contents/MacOS/idea"));
        executable(&root.join("Applications/PyCharm CE.app/Contents/MacOS/pycharm"));
        let found = detect(&env(root));
        assert_eq!(summary(&found), [
            ("jetbrains-idea", "IntelliJ IDEA", root.join("home/Applications/IntelliJ IDEA Ultimate.app/Contents/MacOS/idea")),
            ("jetbrains-phpstorm", "PhpStorm", scripts.join("phpstorm")),
            ("jetbrains-webstorm", "WebStorm", root.join("bin/webstorm")),
            ("jetbrains-pycharm", "PyCharm", root.join("Applications/PyCharm CE.app/Contents/MacOS/pycharm")),
            ("file-manager", "Finder", PathBuf::from("/usr/bin/open")),
        ]);
    }
}
