//! "Open in…" on Windows: the editors and IDEs found on `PATH` (with `PATHEXT`) and in their
//! per-user and per-machine install folders, JetBrains IDEs through the Toolbox (its
//! `state.json`, else its shell scripts), and File Explorer.
//!
//! Plain file checks only, so the tests run anywhere (on fake folders); `WinEnv::from_system`
//! reads the real environment on Windows.
//!
//! A launcher may be a `.cmd` shim (`code.cmd`, a Toolbox script): it runs as an argv like any
//! other, and std's `Command` runs a batch file through `cmd.exe` with each argument escaped
//! for it (Rust's documented batch-file escaping, the CVE-2024-24576 fix; an argument it can't
//! escape safely fails the spawn). That holds whatever the shim does inside, unlike calling
//! `Code.exe` with its `cli.js` directly, which depends on each editor's install layout.

use super::{ArgStyle, Opener, OpenerKind, JETBRAINS};
use std::path::{Path, PathBuf};

/// The extensions a `Command` can start directly, in `PATHEXT`'s default order. `PATHEXT` may
/// list more (`.js`, `.vbs`, …), which only the shell knows how to run.
const RUNNABLE: &[&str] = &[".com", ".exe", ".bat", ".cmd"];

/// Where detection looks. `from_system` reads the real environment; tests build their own.
pub struct WinEnv {
    /// `%PATH%`, in order.
    pub path: Vec<PathBuf>,
    /// `%PATHEXT%`'s runnable extensions (`runnable_exts`), lowercase with the dot.
    pub pathext: Vec<String>,
    /// `%LOCALAPPDATA%`: per-user installs (`Programs\…`) and the JetBrains Toolbox.
    pub local_app_data: Option<PathBuf>,
    /// `%ProgramW6432%`, `%ProgramFiles%`, `%ProgramFiles(x86)%`: per-machine installs.
    pub program_files: Vec<PathBuf>,
    /// `%SystemRoot%`, where `explorer.exe` is.
    pub system_root: Option<PathBuf>,
}

impl WinEnv {
    #[cfg(windows)]
    pub fn from_system() -> Self {
        let var = |k: &str| std::env::var_os(k).map(PathBuf::from).filter(|p| p.is_absolute());
        let path = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).filter(|d| d.is_absolute()).collect()).unwrap_or_default();
        let mut program_files: Vec<PathBuf> = Vec::new();
        for p in ["ProgramW6432", "ProgramFiles", "ProgramFiles(x86)"].into_iter().filter_map(var) {
            if !program_files.contains(&p) {
                program_files.push(p);
            }
        }
        Self {
            path,
            pathext: runnable_exts(&std::env::var("PATHEXT").unwrap_or_default()),
            local_app_data: var("LOCALAPPDATA"),
            program_files,
            system_root: var("SystemRoot").or_else(|| var("windir")),
        }
    }
}

/// `PATHEXT`'s extensions that a `Command` can start (`RUNNABLE`), in its order; the default
/// order when it lists none.
pub fn runnable_exts(pathext: &str) -> Vec<String> {
    let exts: Vec<String> = pathext.split(';').map(|e| e.trim().to_ascii_lowercase()).filter(|e| RUNNABLE.contains(&e.as_str())).collect();
    if exts.is_empty() { RUNNABLE.iter().map(|e| e.to_string()).collect() } else { exts }
}

/// `name` on `path`, as Windows finds a command: in each folder in turn, `name` plus each of
/// `exts`, or `name` itself when it already ends in one of them. An extensionless file (VS Code's
/// `bin\code`, a script for Git Bash) is never a match: Windows can't start it.
pub fn find_program(path: &[PathBuf], exts: &[String], name: &str) -> Option<PathBuf> {
    let lower = name.to_ascii_lowercase();
    let names: Vec<String> = if exts.iter().any(|e| lower.ends_with(e.as_str())) { vec![name.to_string()] } else { exts.iter().map(|e| format!("{name}{e}")).collect() };
    path.iter().flat_map(|d| names.iter().map(move |n| d.join(n))).find(|p| p.is_file())
}

/// `base` joined with `parts`, one component each.
fn under(base: &Path, parts: &[&str]) -> PathBuf {
    parts.iter().fold(base.to_path_buf(), |p, part| p.join(part))
}

/// The JetBrains IDEs the Toolbox installed, from its `state.json`: each tool's install folder
/// joined with its launch command (`bin\idea64.exe`), keyed by our launcher name (`idea`). Read
/// leniently: a missing or unreadable file, or an entry without these fields, is skipped.
pub fn toolbox_state(local_app_data: &Path) -> Vec<(String, PathBuf)> {
    #[derive(serde::Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Tool {
        install_location: Option<PathBuf>,
        launch_command: Option<String>,
    }
    #[derive(serde::Deserialize)]
    struct State {
        #[serde(default)]
        tools: Vec<serde_json::Value>,
    }
    let file = under(local_app_data, &["JetBrains", "Toolbox", "state.json"]);
    let Some(state) = std::fs::read(&file).ok().and_then(|b| serde_json::from_slice::<State>(&b).ok()) else { return Vec::new() };
    let mut out = Vec::new();
    for tool in state.tools.into_iter().filter_map(|t| serde_json::from_value::<Tool>(t).ok()) {
        let (Some(dir), Some(cmd)) = (tool.install_location, tool.launch_command) else { continue };
        // `bin/idea64.exe` or `bin\idea64.exe`: one component each, so it stays under `dir`.
        let parts: Vec<&str> = cmd.split(['/', '\\']).filter(|p| !p.is_empty()).collect();
        if !dir.is_absolute() || parts.iter().any(|p| *p == ".." || p.contains(':')) {
            continue;
        }
        let exe = under(&dir, &parts);
        let stem = exe.file_stem().map(|s| s.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
        let key = stem.strip_suffix("64").unwrap_or(&stem).to_string();
        if JETBRAINS.iter().any(|(k, _)| *k == key) && exe.is_file() && !out.iter().any(|(k, _)| *k == key) {
            out.push((key, exe));
        }
    }
    out
}

/// Every opener found: editors and IDEs (the known ones first, as on Linux), then File Explorer.
pub fn detect(env: &WinEnv) -> Vec<Opener> {
    let mut found: Vec<Opener> = Vec::new();
    let in_path = |names: &[&str]| names.iter().find_map(|n| find_program(&env.path, &env.pathext, n));
    // Per-user installs (`%LOCALAPPDATA%\Programs\…`) before per-machine ones.
    let installed = |user: &[&str], machine: &[&str]| {
        let user = env.local_app_data.iter().map(|l| under(&l.join("Programs"), user));
        let machine = env.program_files.iter().map(|p| under(p, machine));
        user.chain(machine).find(|p| p.is_file())
    };
    let mut add = |id: &str, name: &str, program: Option<PathBuf>, style: ArgStyle| {
        if let Some(p) = program.filter(|_| !found.iter().any(|o| o.id == id)) {
            found.push(Opener::new(id, name, OpenerKind::Editor, p, style));
        }
    };
    let code = ["Microsoft VS Code", "bin", "code.cmd"];
    add("vscode", "VS Code", in_path(&["code"]).or_else(|| installed(&code, &code)), ArgStyle::VsCode);
    let cursor = ["cursor", "resources", "app", "bin", "cursor.cmd"];
    add("cursor", "Cursor", in_path(&["cursor"]).or_else(|| installed(&cursor, &cursor)), ArgStyle::VsCode);
    let codium = ["VSCodium", "bin", "codium.cmd"];
    add("vscodium", "VSCodium", in_path(&["codium"]).or_else(|| installed(&codium, &codium)), ArgStyle::VsCode);

    // JetBrains: the Toolbox's own record of each IDE's executable, else its shell script, else
    // a launcher on PATH (a standalone install's `bin`).
    let state = env.local_app_data.as_deref().map(toolbox_state).unwrap_or_default();
    let scripts = env.local_app_data.as_ref().map(|l| under(l, &["JetBrains", "Toolbox", "scripts"]));
    for (key, name) in JETBRAINS {
        let from_state = state.iter().find(|(k, _)| k == key).map(|(_, exe)| exe.clone());
        let script = || scripts.as_ref().and_then(|s| find_program(std::slice::from_ref(s), &env.pathext, key));
        let program = from_state.or_else(script).or_else(|| in_path(&[&format!("{key}64"), key]));
        add(&format!("jetbrains-{key}"), name, program, ArgStyle::JetBrains);
    }

    let sublime = ["Sublime Text", "subl.exe"];
    let sublime3 = ["Sublime Text 3", "subl.exe"];
    add("sublime", "Sublime Text", in_path(&["subl"]).or_else(|| installed(&sublime, &sublime)).or_else(|| installed(&sublime3, &sublime3)), ArgStyle::PathColonLine);
    let npp = ["Notepad++", "notepad++.exe"];
    add("notepad-plus-plus", "Notepad++", in_path(&["notepad++"]).or_else(|| installed(&npp, &npp)), ArgStyle::NotepadPlusPlus);
    add("zed", "Zed", in_path(&["zed"]), ArgStyle::PathColonLine);
    found.sort_by_key(super::rank);

    let explorer = env.system_root.as_ref().map_or_else(|| PathBuf::from("explorer.exe"), |r| r.join("explorer.exe"));
    found.push(Opener::new("file-manager", "File Explorer", OpenerKind::FileManager, explorer, ArgStyle::ExplorerSelect));
    found
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::openers::tests::args;

    fn file(p: &Path) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, "").unwrap();
    }

    fn env(root: &Path) -> WinEnv {
        WinEnv {
            path: vec![root.join("bin"), root.join("tools")],
            pathext: runnable_exts(".COM;.EXE;.BAT;.CMD;.VBS;.JS"),
            local_app_data: Some(root.join("local")),
            program_files: vec![root.join("pf"), root.join("pf86")],
            system_root: Some(root.join("win")),
        }
    }

    fn summary(found: &[Opener]) -> Vec<(&str, &str, PathBuf)> {
        found.iter().map(|o| (o.id.as_str(), o.name.as_str(), o.program().to_path_buf())).collect()
    }

    #[test]
    fn pathext_keeps_the_extensions_a_command_can_start_in_its_order() {
        assert_eq!(runnable_exts(".COM;.EXE;.BAT;.CMD;.VBS;.VBE;.JS;.JSE;.WSF;.WSH;.MSC"), [".com", ".exe", ".bat", ".cmd"]);
        assert_eq!(runnable_exts(".CMD;.exe"), [".cmd", ".exe"]);
        assert_eq!(runnable_exts(""), [".com", ".exe", ".bat", ".cmd"], "unset: the default order");
        assert_eq!(runnable_exts(".JS;.VBS"), [".com", ".exe", ".bat", ".cmd"]);
    }

    #[test]
    fn a_command_is_found_with_pathext_folder_by_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let e = env(root);
        // VS Code's `bin` holds `code` (for Git Bash) beside `code.cmd`: only the latter runs.
        file(&root.join("tools/code"));
        assert_eq!(find_program(&e.path, &e.pathext, "code"), None, "an extensionless file never matches");
        file(&root.join("tools/code.cmd"));
        assert_eq!(find_program(&e.path, &e.pathext, "code"), Some(root.join("tools/code.cmd")));
        // An earlier folder wins over a better extension in a later one.
        file(&root.join("bin/code.bat"));
        assert_eq!(find_program(&e.path, &e.pathext, "code"), Some(root.join("bin/code.bat")));
        // Within a folder, PATHEXT's order.
        file(&root.join("bin/code.exe"));
        assert_eq!(find_program(&e.path, &e.pathext, "code"), Some(root.join("bin/code.exe")));
        // A name with its extension is looked up as it is; one PATHEXT can't run, never.
        assert_eq!(find_program(&e.path, &e.pathext, "code.cmd"), Some(root.join("tools/code.cmd")));
        file(&root.join("bin/x.js"));
        assert_eq!(find_program(&e.path, &e.pathext, "x"), None);
    }

    #[test]
    fn nothing_installed_is_only_file_explorer_selecting_the_file() {
        let tmp = tempfile::tempdir().unwrap();
        let found = detect(&env(tmp.path()));
        assert_eq!(summary(&found), [("file-manager", "File Explorer", tmp.path().join("win/explorer.exe"))]);
        assert_eq!(found[0].kind, OpenerKind::FileManager);
        let shown = found[0].reveal_command(Path::new(r"C:\r\src\a b.php")).expect("Explorer selects a file");
        assert_eq!(args(&shown), ["/select,", r"C:\r\src\a b.php"]);
        assert_eq!(args(&found[0].command(Path::new(r"C:\r\src"), Some(3))), [r"C:\r\src"], "a folder just opens");
    }

    #[test]
    fn editors_are_found_on_path_then_in_the_user_then_the_machine_install_folders() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        file(&root.join("local/Programs/Microsoft VS Code/bin/code.cmd"));
        file(&root.join("pf/Microsoft VS Code/bin/code.cmd"));
        file(&root.join("pf/cursor/resources/app/bin/cursor.cmd"));
        file(&root.join("tools/codium.cmd"));
        file(&root.join("pf/VSCodium/bin/codium.cmd"));
        file(&root.join("pf86/Notepad++/notepad++.exe"));
        file(&root.join("pf/Sublime Text 3/subl.exe"));
        file(&root.join("bin/zed.exe"));
        let found = detect(&env(root));
        assert_eq!(summary(&found), [
            ("vscode", "VS Code", root.join("local/Programs/Microsoft VS Code/bin/code.cmd")),
            ("vscodium", "VSCodium", root.join("tools/codium.cmd")),
            ("sublime", "Sublime Text", root.join("pf/Sublime Text 3/subl.exe")),
            ("zed", "Zed", root.join("bin/zed.exe")),
            ("cursor", "Cursor", root.join("pf/cursor/resources/app/bin/cursor.cmd")),
            ("notepad-plus-plus", "Notepad++", root.join("pf86/Notepad++/notepad++.exe")),
            ("file-manager", "File Explorer", root.join("win/explorer.exe")),
        ]);
    }

    #[test]
    fn each_editor_keeps_its_file_and_line_arguments() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        file(&root.join("bin/code.cmd"));
        file(&root.join("bin/notepad++.exe"));
        file(&root.join("bin/subl.exe"));
        file(&root.join("local/JetBrains/Toolbox/scripts/phpstorm.cmd"));
        let found = detect(&env(root));
        let open = |id: &str, line| args(&found.iter().find(|o| o.id == id).unwrap().command(Path::new(r"C:\r\a b.php"), line));
        assert_eq!(open("vscode", Some(12)), ["-g", r"C:\r\a b.php:12"]);
        assert_eq!(open("vscode", None), [r"C:\r\a b.php"]);
        assert_eq!(open("jetbrains-phpstorm", Some(7)), ["--line", "7", r"C:\r\a b.php"]);
        assert_eq!(open("sublime", Some(3)), [r"C:\r\a b.php:3"]);
        assert_eq!(open("notepad-plus-plus", Some(9)), ["-n9", r"C:\r\a b.php"]);
        assert_eq!(open("notepad-plus-plus", None), [r"C:\r\a b.php"]);
    }

    #[test]
    fn jetbrains_ides_come_from_the_toolbox_state_then_its_scripts_then_path() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let apps = root.join("local/Programs");
        file(&apps.join("PhpStorm/bin/phpstorm64.exe"));
        file(&apps.join("IntelliJ IDEA Ultimate/bin/idea64.exe"));
        let state = serde_json::json!({
            "appVersion": "2.5.2.35332",
            "tools": [
                {"toolId": "PhpStorm", "displayName": "PhpStorm", "installLocation": apps.join("PhpStorm"), "launchCommand": "bin\\phpstorm64.exe"},
                {"toolId": "IDEA-U", "displayName": "IntelliJ IDEA Ultimate", "installLocation": apps.join("IntelliJ IDEA Ultimate"), "launchCommand": "bin/idea64.exe"},
                // Not installed any more, a product we don't list, an escape from its folder, fields missing:
                {"toolId": "Goland", "installLocation": apps.join("GoLand"), "launchCommand": "bin\\goland64.exe"},
                {"toolId": "Fleet", "installLocation": apps.join("PhpStorm"), "launchCommand": "bin\\phpstorm64.exe\\..\\fleet.exe"},
                {"toolId": "Rider", "installLocation": apps.join("PhpStorm"), "launchCommand": "..\\PhpStorm\\bin\\phpstorm64.exe"},
                {"toolId": "CLion"},
                "not an object"
            ]
        });
        file(&root.join("local/JetBrains/Toolbox/state.json"));
        std::fs::write(root.join("local/JetBrains/Toolbox/state.json"), state.to_string()).unwrap();
        // A script for an IDE the state already gives is ignored; one only the scripts have is used.
        file(&root.join("local/JetBrains/Toolbox/scripts/phpstorm.cmd"));
        file(&root.join("local/JetBrains/Toolbox/scripts/webstorm.cmd"));
        file(&root.join("tools/pycharm64.exe"));
        file(&root.join("bin/pycharm.bat"));
        let found = detect(&env(root));
        assert_eq!(summary(&found), [
            ("jetbrains-idea", "IntelliJ IDEA", apps.join("IntelliJ IDEA Ultimate/bin/idea64.exe")),
            ("jetbrains-phpstorm", "PhpStorm", apps.join("PhpStorm/bin/phpstorm64.exe")),
            ("jetbrains-webstorm", "WebStorm", root.join("local/JetBrains/Toolbox/scripts/webstorm.cmd")),
            ("jetbrains-pycharm", "PyCharm", root.join("tools/pycharm64.exe")),
            ("file-manager", "File Explorer", root.join("win/explorer.exe")),
        ]);
    }

    #[test]
    fn an_unreadable_toolbox_state_is_ignored() {
        let tmp = tempfile::tempdir().unwrap();
        let local = tmp.path().join("local");
        assert!(toolbox_state(&local).is_empty(), "no Toolbox");
        file(&local.join("JetBrains/Toolbox/state.json"));
        std::fs::write(local.join("JetBrains/Toolbox/state.json"), "{ not json").unwrap();
        assert!(toolbox_state(&local).is_empty());
        std::fs::write(local.join("JetBrains/Toolbox/state.json"), r#"{"tools": {"oops": 1}}"#).unwrap();
        assert!(toolbox_state(&local).is_empty());
    }
}
