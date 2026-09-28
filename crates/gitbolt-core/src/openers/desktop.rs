//! Editors from XDG desktop entries (feedback H32): every `applications/` directory of
//! `$XDG_DATA_HOME` and `$XDG_DATA_DIRS` (Flatpak's and Snap's exports are among them), filtered
//! to text editors and IDEs.

use super::{parse_exec, resolve_program, ArgStyle, DetectEnv, ExecArg, LineArgs, Opener, OpenerKind, JETBRAINS};
use std::collections::HashSet;
use std::path::{Path, PathBuf};

/// The `[Desktop Entry]` keys detection reads (unlocalized values, string escapes applied).
#[derive(Debug, Default)]
struct Entry {
    kind: Option<String>,
    name: Option<String>,
    exec: Option<String>,
    try_exec: Option<String>,
    categories: Vec<String>,
    mime: Vec<String>,
    hidden: bool,
    no_display: bool,
    terminal: bool,
}

fn parse_entry(text: &str) -> Entry {
    let mut e = Entry::default();
    let mut in_main = false;
    let list = |v: &str| v.split(';').map(str::trim).filter(|s| !s.is_empty()).map(String::from).collect::<Vec<_>>();
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            in_main = line == "[Desktop Entry]";
            continue;
        }
        let Some((key, value)) = line.split_once('=').filter(|_| in_main) else { continue };
        let value = unescape(value.trim());
        // `Name[fr]` and the like are localized keys: only the plain key counts.
        match key.trim() {
            "Type" => e.kind = Some(value),
            "Name" => e.name = Some(value),
            "Exec" => e.exec = Some(value),
            "TryExec" => e.try_exec = Some(value),
            "Categories" => e.categories = list(&value),
            "MimeType" => e.mime = list(&value),
            "Hidden" => e.hidden = value == "true",
            "NoDisplay" => e.no_display = value == "true",
            "Terminal" => e.terminal = value == "true",
            _ => {}
        }
    }
    e
}

/// A string value's escapes (`\s \n \t \r \\`), applied before `parse_exec`'s quoting rule, as
/// the spec says (a literal backslash in a quoted `Exec` argument is written `\\\\`).
fn unescape(v: &str) -> String {
    let mut out = String::new();
    let mut cs = v.chars();
    while let Some(c) = cs.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match cs.next() {
            Some('\\') => out.push('\\'),
            Some('s') => out.push(' '),
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('r') => out.push('\r'),
            Some(o) => {
                out.push('\\');
                out.push(o);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// Every desktop entry file with its id, each id from the first data directory that has it (the
/// spec's precedence: a user's `Hidden=true` copy hides the system one). Subdirectories give
/// `dir-name.desktop` ids; symlinked directories aren't followed, symlinked files are (Flatpak's
/// and Snap's exports are symlinks).
fn entry_files(env: &DetectEnv) -> Vec<(String, PathBuf)> {
    fn walk(dir: &Path, prefix: &str, depth: usize, seen: &mut HashSet<String>, out: &mut Vec<(String, PathBuf)>) {
        let Ok(rd) = std::fs::read_dir(dir) else { return };
        let mut entries: Vec<_> = rd.flatten().collect();
        entries.sort_by_key(|e| e.file_name());
        for e in entries {
            let name = e.file_name().to_string_lossy().into_owned();
            let path = e.path();
            if e.file_type().is_ok_and(|t| t.is_dir()) {
                if depth < 3 {
                    walk(&path, &format!("{prefix}{name}-"), depth + 1, seen, out);
                }
            } else if name.ends_with(".desktop") && path.is_file() {
                let id = format!("{prefix}{name}");
                if seen.insert(id.clone()) {
                    out.push((id, path));
                }
            }
        }
    }
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for d in &env.data_dirs {
        walk(&d.join("applications"), "", 0, &mut seen, &mut out);
    }
    out
}

/// Categories that are editors whatever else they say.
const EDITOR_CATEGORIES: &[&str] = &["TextEditor", "IDE"];
/// Apps that list text or source types without being editors (browsers, mail, office, media,
/// terminals, git clients, file managers).
const NOT_EDITORS: &[&str] = &[
    "WebBrowser", "Email", "Office", "WordProcessor", "Spreadsheet", "Presentation", "AudioVideo", "Audio", "Video", "Player", "Graphics",
    "TerminalEmulator", "RevisionControl", "FileManager",
];

fn source_mime(m: &str) -> bool {
    m == "text/plain"
        || m.starts_with("text/x-")
        || matches!(
            m,
            "text/markdown" | "text/css" | "text/javascript" | "application/javascript" | "application/x-javascript" | "application/json" | "application/x-php"
                | "application/x-shellscript" | "application/x-sh" | "application/x-ruby" | "application/x-perl" | "application/x-python" | "application/toml"
                | "application/x-yaml" | "application/yaml" | "application/typescript"
        )
}

/// A text editor or IDE: an editor category, or (not a browser, mail client, …) an app that opens
/// plain text or source files.
fn is_editor(e: &Entry) -> bool {
    let has = |cats: &[&str]| e.categories.iter().any(|c| cats.contains(&c.as_str()));
    has(EDITOR_CATEGORIES) || (!has(NOT_EDITORS) && e.mime.iter().any(|m| source_mime(m)))
}

/// A JetBrains product key from a packaging's name for it: `phpstorm`, `intellij-idea-ultimate`
/// (snap), `IntelliJ-IDEA-Community` (Flatpak), `pycharm-professional`.
fn jetbrains_key(product: &str) -> Option<&'static str> {
    let p = product.to_ascii_lowercase();
    let p = p.trim_end_matches("-ultimate").trim_end_matches("-community").trim_end_matches("-professional").trim_end_matches("-eap");
    let p = if p == "intellij-idea" || p == "intellij" { "idea" } else { p };
    JETBRAINS.iter().find(|(k, _)| *k == p).map(|(k, _)| *k)
}

/// The known editors (H32), from their desktop ids across packagings: distro and upstream
/// (`code`), Flatpak (`com.visualstudio.code`), Snap (`code_code`), JetBrains Toolbox
/// (`jetbrains-phpstorm-<hash>`). Their id, name and (for the IDEs whose CLI takes one) line form.
fn known(stem: &str) -> Option<(String, &'static str, Option<LineArgs>)> {
    let fixed = |id: &str, name: &'static str, line| Some((id.to_string(), name, line));
    match stem {
        "code" | "com.visualstudio.code" | "code_code" | "visual-studio-code" => return fixed("vscode", "VS Code", Some(LineArgs::VsCode)),
        "codium" | "vscodium" | "com.vscodium.codium" | "codium_codium" => return fixed("vscodium", "VSCodium", Some(LineArgs::VsCode)),
        "sublime_text" | "com.sublimetext.three" | "sublime-text_subl" | "sublime-text" => return fixed("sublime", "Sublime Text", Some(LineArgs::PathColonLine)),
        "dev.zed.Zed" | "zed" | "zed_zed" => return fixed("zed", "Zed", Some(LineArgs::PathColonLine)),
        "org.kde.kate" | "kate" | "kate_kate" => return fixed("kate", "Kate", None),
        "org.gnome.gedit" | "gedit" | "gedit_gedit" => return fixed("gedit", "gedit", None),
        "org.gnome.TextEditor" => return fixed("gnome-text-editor", "Text Editor", None),
        _ => {}
    }
    let product = stem
        .strip_prefix("jetbrains-")
        .map(|s| s.split('-').next().unwrap_or(s))
        .or_else(|| stem.strip_prefix("com.jetbrains."))
        .or_else(|| stem.split_once('_').map(|(snap, _)| snap))?;
    let key = jetbrains_key(product)?;
    let name = JETBRAINS.iter().find(|(k, _)| *k == key).map(|(_, n)| *n)?;
    Some((format!("jetbrains-{key}"), name, Some(LineArgs::JetBrains)))
}

/// An entry's program and arguments, when it can run here (`TryExec` and the program exist) and
/// isn't GitBolt itself.
fn runnable(env: &DetectEnv, e: &Entry) -> Option<(PathBuf, Vec<ExecArg>)> {
    if let Some(t) = &e.try_exec {
        resolve_program(env, t)?;
    }
    let (program, args) = parse_exec(e.exec.as_deref()?)?;
    let program = resolve_program(env, &program)?;
    let canonical = |p: &Path| p.canonicalize().unwrap_or_else(|_| p.to_path_buf());
    if env.self_exe.as_deref().is_some_and(|me| canonical(me) == canonical(&program)) {
        return None;
    }
    Some((program, args))
}

/// The editors among the desktop entries (unsorted; `detect` sorts them), one per app: the known
/// editors by their stable id, the others as `desktop:<desktop id without .desktop>`.
pub(super) fn editors(env: &DetectEnv) -> Vec<Opener> {
    let mut found: Vec<Opener> = Vec::new();
    for (id, path) in entry_files(env) {
        let stem = id.trim_end_matches(".desktop");
        if stem.to_ascii_lowercase().starts_with("gitbolt") {
            continue;
        }
        let Ok(text) = std::fs::read_to_string(&path) else { continue };
        let e = parse_entry(&text);
        if e.hidden || e.no_display || e.terminal || e.kind.as_deref().is_some_and(|k| k != "Application") || !is_editor(&e) {
            continue;
        }
        let Some((program, args)) = runnable(env, &e) else { continue };
        let (opener_id, name, line) = match known(stem) {
            Some((id, name, line)) => (id, name.to_string(), line),
            None => (format!("desktop:{stem}"), e.name.clone().unwrap_or_else(|| stem.to_string()), None),
        };
        if found.iter().any(|o| o.id == opener_id) {
            continue;
        }
        // Flatpak's `@@`/`@@u` file forwarding only passes real paths: no `path:line` or flags
        // inside it, so a Flatpak IDE opens the file without the line.
        let forwards = args.iter().any(|a| matches!(a, ExecArg::Literal(s) if s.to_string_lossy().starts_with("@@")));
        let style = match line.filter(|_| !forwards) {
            Some(l) => ArgStyle::ExecWithLine(args, l),
            None => ArgStyle::Exec(args),
        };
        found.push(Opener::new(opener_id, name, OpenerKind::Editor, program, style));
    }
    found
}

/// The opener for one desktop entry id (the file manager: `xdg-mime`'s `inode/directory`),
/// wherever it lives in the data directories.
pub(super) fn entry_opener(env: &DetectEnv, desktop_id: &str, id: &str, kind: OpenerKind) -> Option<Opener> {
    let (_, path) = entry_files(env).into_iter().find(|(i, _)| i == desktop_id)?;
    let e = parse_entry(&std::fs::read_to_string(path).ok()?);
    if e.hidden {
        return None;
    }
    let (program, args) = runnable(env, &e)?;
    Some(Opener::new(id, e.name.clone().unwrap_or_else(|| desktop_id.to_string()), kind, program, ArgStyle::Exec(args)))
}

#[cfg(test)]
mod tests {
    use super::super::tests::{args, desktop, executable};
    use super::super::*;
    use std::path::Path;

    const EDITOR: &str = "Type=Application\nCategories=Utility;TextEditor;\n";

    struct Tree {
        _tmp: tempfile::TempDir,
        root: PathBuf,
        env: DetectEnv,
    }

    /// `$XDG_DATA_HOME`, a Flatpak export, `/usr/share` and Snap's directory, in that order,
    /// with `bin/` as `PATH`.
    fn tree() -> Tree {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().to_path_buf();
        let env = DetectEnv {
            path: vec![root.join("bin")],
            home: Some(root.join("home")),
            data_dirs: ["home/.local/share", "flatpak/exports/share", "usr/share", "snapd/desktop"].iter().map(|d| root.join(d)).collect(),
            mime_default: Box::new(|_| None),
            self_exe: Some(root.join("opt/gitbolt/gitbolt")),
        };
        Tree { _tmp: tmp, root, env }
    }

    fn ids(found: &[Opener]) -> Vec<&str> {
        found.iter().map(|o| o.id.as_str()).collect()
    }

    #[test]
    fn editors_come_from_categories_or_source_mime_types_and_the_rest_are_skipped() {
        let t = tree();
        let (r, home, sys) = (&t.root, t.root.join("home/.local/share"), t.root.join("usr/share"));
        for p in ["bin/mousepad", "bin/beta", "bin/firefox", "bin/vim", "bin/hidden", "bin/nodisplay", "bin/sysprof", "bin/zz", "opt/gitbolt/gitbolt", "bin/kitty"] {
            executable(&r.join(p));
        }
        desktop(&sys, "org.xfce.mousepad.desktop", &format!("[Desktop Entry]\nName=Mousepad\nExec=mousepad %U\n{EDITOR}"));
        // No editor category, but it opens source files.
        desktop(&sys, "beta.desktop", "[Desktop Entry]\nType=Application\nName=Beta Editor\nExec=beta %F\nCategories=Utility;\nMimeType=image/png;text/x-python;\n");
        // Opens text/plain, but it's a browser.
        desktop(&sys, "firefox.desktop", "[Desktop Entry]\nType=Application\nName=Firefox\nExec=firefox %u\nCategories=Network;WebBrowser;\nMimeType=text/html;text/plain;\n");
        // Development alone isn't an editor.
        desktop(&sys, "org.gnome.Sysprof.desktop", "[Desktop Entry]\nType=Application\nName=Sysprof\nExec=sysprof\nCategories=Development;GTK;\n");
        // Skipped: terminal-only, NoDisplay, Hidden, a missing TryExec, a missing program, not an
        // application, GitBolt itself (by id and by program).
        desktop(&sys, "vim.desktop", &format!("[Desktop Entry]\nName=Vim\nExec=vim %F\nTerminal=true\n{EDITOR}"));
        desktop(&sys, "nodisplay.desktop", &format!("[Desktop Entry]\nName=Handler\nExec=nodisplay %u\nNoDisplay=true\n{EDITOR}"));
        desktop(&sys, "hidden.desktop", &format!("[Desktop Entry]\nName=Hidden\nExec=hidden %u\nHidden=true\n{EDITOR}"));
        desktop(&sys, "tryexec.desktop", &format!("[Desktop Entry]\nName=Try\nExec=mousepad %F\nTryExec=/nope/try\n{EDITOR}"));
        desktop(&sys, "gone.desktop", &format!("[Desktop Entry]\nName=Gone\nExec=/nope/gone %F\n{EDITOR}"));
        desktop(&sys, "link.desktop", "[Desktop Entry]\nType=Link\nName=Link\nURL=https://x\nCategories=TextEditor;\n");
        desktop(&sys, "gitbolt.desktop", &format!("[Desktop Entry]\nName=GitBolt\nExec=mousepad\n{EDITOR}"));
        desktop(&sys, "bolt-alias.desktop", &format!("[Desktop Entry]\nName=Alias\nExec={}/opt/gitbolt/gitbolt %F\n{EDITOR}", r.display()));
        desktop(&sys, "kitty-open.desktop", "[Desktop Entry]\nType=Application\nName=kitty\nExec=kitty %U\nCategories=System;TerminalEmulator;\nMimeType=text/*;\n");
        // A subdirectory's entries have `dir-name` ids.
        desktop(&sys, "vendor/zz.desktop", &format!("[Desktop Entry]\nName=Zz Edit\nExec=zz %f\n{EDITOR}"));
        // Only [Desktop Entry] counts, and the unlocalized Name.
        desktop(&home, "localized.desktop", &format!("[Desktop Entry]\nName[fr]=Éditeur\nName=Local Edit\nExec=mousepad %F\n{EDITOR}[Desktop Action x]\nName=Other\nExec=nope\n"));
        let found = detect(&t.env);
        let names: Vec<&str> = found.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, ["Beta Editor", "Local Edit", "Mousepad", "Zz Edit"], "alphabetical after the known editors");
        assert_eq!(ids(&found), ["desktop:beta", "desktop:localized", "desktop:org.xfce.mousepad", "desktop:vendor-zz"]);
        assert_eq!(found[2].program(), r.join("bin/mousepad"));
        assert_eq!(args(&found[2].command(Path::new("/w/a b.txt"), Some(4))), ["/w/a b.txt"], "no line for an unknown editor");
    }

    #[test]
    fn known_editors_are_recognised_whatever_their_packaging_deduplicated_and_sorted_first() {
        let t = tree();
        let (r, home, flat, sys, snap) = (&t.root, t.root.join("home/.local/share"), t.root.join("flatpak/exports/share"), t.root.join("usr/share"), t.root.join("snapd/desktop"));
        for p in ["opt/code/code", "usr/bin/flatpak", "snap/bin/phpstorm", "bin/gnome-text-editor", "bin/gedit", "bin/zeditor", "bin/code", "opt/mousepad"] {
            executable(&r.join(p));
        }
        executable(&r.join("home/.local/share/JetBrains/Toolbox/scripts/phpstorm"));
        executable(&r.join("home/.local/share/JetBrains/Toolbox/apps/webstorm/bin/webstorm"));
        let dev = "Type=Application\nCategories=Development;IDE;\n";
        desktop(&home, "code.desktop", &format!("[Desktop Entry]\nName=Visual Studio Code\nExec={}/opt/code/code %F\n{dev}", r.display()));
        // The same apps packaged again: the first data directory's copy wins.
        desktop(&flat, "com.visualstudio.code.desktop", &format!("[Desktop Entry]\nName=Visual Studio Code\nExec={}/usr/bin/flatpak run --command=code com.visualstudio.code @@ %F @@\n{dev}", r.display()));
        desktop(&snap, "code_code.desktop", &format!("[Desktop Entry]\nName=Visual Studio Code\nExec=/snap/bin/code %F\n{dev}"));
        // A snap PhpStorm and the Toolbox script: the desktop entry is preferred.
        desktop(&snap, "phpstorm_phpstorm.desktop", &format!("[Desktop Entry]\nName=PhpStorm\nExec={}/snap/bin/phpstorm %f\n{dev}", r.display()));
        desktop(&home, "jetbrains-webstorm-51c3.desktop", &format!("[Desktop Entry]\nName=WebStorm 2026.2\nExec=\"{}/home/.local/share/JetBrains/Toolbox/apps/webstorm/bin/webstorm\" %u\n{dev}", r.display()));
        desktop(&sys, "org.gnome.TextEditor.desktop", &format!("[Desktop Entry]\nName=Text Editor\nExec=gnome-text-editor %U\n{EDITOR}MimeType=text/plain;\n"));
        // A user override hides the system gedit.
        desktop(&home, "org.gnome.gedit.desktop", &format!("[Desktop Entry]\nName=gedit\nExec=gedit %U\nHidden=true\n{EDITOR}"));
        desktop(&sys, "org.gnome.gedit.desktop", &format!("[Desktop Entry]\nName=gedit\nExec=gedit %U\n{EDITOR}"));
        desktop(&sys, "org.xfce.mousepad.desktop", &format!("[Desktop Entry]\nName=Mousepad\nExec={}/opt/mousepad %U\n{EDITOR}", r.display()));
        let found = detect(&t.env);
        assert_eq!(ids(&found), ["vscode", "jetbrains-phpstorm", "jetbrains-webstorm", "zed", "gnome-text-editor", "desktop:org.xfce.mousepad"]);
        let names: Vec<&str> = found.iter().map(|o| o.name.as_str()).collect();
        assert_eq!(names, ["VS Code", "PhpStorm", "WebStorm", "Zed", "Text Editor", "Mousepad"]);
        // The .desktop Exec is what runs, with the line where the IDE's CLI takes it.
        let f = Path::new("/w/src/app.php");
        let code = found[0].command(f, Some(12));
        assert_eq!(code.program, r.join("opt/code/code"));
        assert_eq!(args(&code), ["-g", "/w/src/app.php:12"]);
        let php = found[1].command(f, Some(3));
        assert_eq!(php.program, r.join("snap/bin/phpstorm"), "the desktop entry beats the Toolbox script");
        assert_eq!(args(&php), ["--line", "3", "/w/src/app.php"]);
        // Zed isn't installed as a desktop entry here: PATH supplements.
        assert_eq!(found[3].program(), r.join("bin/zeditor"));
        assert_eq!(args(&found[3].command(f, Some(9))), ["/w/src/app.php:9"]);
        assert_eq!(args(&found[4].command(f, Some(9))), ["/w/src/app.php"], "Text Editor gets no line");
    }

    #[test]
    fn a_flatpak_ide_forwards_the_file_without_a_line() {
        let t = tree();
        let flat = t.root.join("flatpak/exports/share");
        executable(&t.root.join("usr/bin/flatpak"));
        desktop(&flat, "com.jetbrains.IntelliJ-IDEA-Ultimate.desktop", &format!("[Desktop Entry]\nType=Application\nName=IntelliJ IDEA Ultimate\nExec={}/usr/bin/flatpak run --command=idea com.jetbrains.IntelliJ-IDEA-Ultimate @@u %U @@\nCategories=Development;IDE;\n", t.root.display()));
        let found = detect(&t.env);
        assert_eq!(ids(&found), ["jetbrains-idea"]);
        assert_eq!(found[0].name, "IntelliJ IDEA");
        let c = found[0].command(Path::new("/w/a.kt"), Some(5));
        assert_eq!(c.program, t.root.join("usr/bin/flatpak"));
        assert_eq!(args(&c), ["run", "--command=idea", "com.jetbrains.IntelliJ-IDEA-Ultimate", "@@u", "/w/a.kt", "@@"]);
    }
}
