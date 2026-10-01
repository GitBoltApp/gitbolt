//! "Open in…" (spec §14.5, feedback H9): the external editors and the file manager found on
//! this machine, and the argv that opens a working-tree file (at a line) in one of them.
//!
//! Security: only programs found here are ever run (the UI names an opener by its `id`, never a
//! program), always as an argv list without a shell, detached from GitBolt. The file is always
//! an absolute path the API has checked with `blob::safe_join`, so it can't be read as an option.
//! Launching goes through an injected `Launcher`: the app spawns (`spawn_detached`), the harness
//! records the call, and tests never start a real application.
//!
//! Detection (feedback H32) is per OS behind `detect_system`: on Linux, every XDG desktop entry
//! that is a text editor or IDE (`desktop.rs`), supplemented by JetBrains Toolbox scripts and
//! `PATH`, plus the file manager; "Other…" is the system's Open With chooser (`chooser.rs`).
//! macOS and Windows plug in at the same seams later (spec §4).

use crate::error::{GbError, GbErrorKind};
use crate::links::UrlOpener;
use serde::Serialize;
use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use ts_rs::TS;

pub mod chooser;
#[cfg(unix)]
mod desktop;
pub mod folder_picker;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum OpenerKind {
    Editor,
    /// Opens the file's folder.
    FileManager,
    /// "Other…": the system's Open With chooser.
    Chooser,
}

/// The id of the "Other…" entry, listed when the API has a `Chooser`.
pub const CHOOSER_ID: &str = "other";

/// The opener id that means "the custom editor command" (R5: the profile's, or the repo's own,
/// `EditorChoice::Custom`), built per open by `template_opener`. Never a detected opener's id.
pub const CUSTOM_ID: &str = "custom";

/// One entry of the "Open in…" menu.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct OpenerPayload {
    pub id: String,
    pub name: String,
    pub kind: OpenerKind,
}

/// One argument of a desktop entry's `Exec` line: literal, or where the file goes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExecArg {
    Literal(OsString),
    File,
    /// The file, as a `file://` URI rather than a plain path: Flatpak's `@@u … @@` forwarding
    /// marks the wrapped field code this way (deferred Rust minor #4). Without it, a sandboxed
    /// app that can't see the host path at all (no `--filesystem=home`) gets a path the document
    /// portal never exported, and can't open it.
    FileUri,
}

/// How a known IDE's CLI takes a line (only these get one; spec §14.5).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LineArgs {
    /// VS Code, VSCodium: `-g <file>:<line>`.
    VsCode,
    /// JetBrains IDEs: `--line <line> <file>`.
    JetBrains,
    /// Sublime Text, Zed: `<file>:<line>`.
    PathColonLine,
}

/// How an opener takes a file and a line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ArgStyle {
    /// `program -g <file>:<line>` (a VS Code launcher on `PATH`).
    VsCode,
    /// `program --line <line> <file>` (a Toolbox script or a launcher on `PATH`).
    JetBrains,
    /// `program <file>:<line>`.
    PathColonLine,
    /// A desktop entry's `Exec` arguments, with the file (or folder) at its field code. No line.
    Exec(Vec<ExecArg>),
    /// A known IDE's desktop entry: its `Exec` arguments, the file's place taking the line form.
    ExecWithLine(Vec<ExecArg>, LineArgs),
    /// A user-configured command template (the custom editor setting): each word, already split
    /// like a shell command line, with `{file}`, `{line}` and `{repo}` substituted per open. The
    /// repository is baked in at construction (`template_opener`) rather than threaded through
    /// `command()`, since every other `ArgStyle` opens a file with no repository context at all.
    /// Never runs through a shell.
    Template { words: Vec<String>, repo: PathBuf },
}

/// A detected opener: what the UI sees (`payload`) and what runs (`program`, `style`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Opener {
    pub id: String,
    pub name: String,
    pub kind: OpenerKind,
    program: PathBuf,
    style: ArgStyle,
}

/// A program and its arguments; never a shell command line.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LaunchCommand {
    pub program: PathBuf,
    pub args: Vec<OsString>,
}

pub type Launcher = Arc<dyn Fn(&LaunchCommand) -> Result<(), GbError> + Send + Sync>;

impl Opener {
    pub fn new(id: impl Into<String>, name: impl Into<String>, kind: OpenerKind, program: impl Into<PathBuf>, style: ArgStyle) -> Self {
        Self { id: id.into(), name: name.into(), kind, program: program.into(), style }
    }

    pub fn payload(&self) -> OpenerPayload {
        OpenerPayload { id: self.id.clone(), name: self.name.clone(), kind: self.kind }
    }

    pub fn program(&self) -> &Path {
        &self.program
    }

    /// The argv that opens `target` (an absolute path: a file for an editor, its folder for the
    /// file manager), at `line` when the opener supports one.
    pub fn command(&self, target: &Path, line: Option<u32>) -> LaunchCommand {
        let file = target.as_os_str().to_owned();
        if let ArgStyle::Template { words, repo } = &self.style {
            // `{line}` is `1` when none is given, like the working-tree file with no selection:
            // simpler than dropping the whole token, and every template editor accepts line 1.
            let line = line.unwrap_or(1).to_string();
            let file_str = file.to_string_lossy();
            let repo_str = repo.to_string_lossy();
            let args = words.iter().map(|w| OsString::from(substitute_template_word(w, &file_str, &line, &repo_str))).collect();
            return LaunchCommand { program: self.program.clone(), args };
        }
        let only_file = [ExecArg::File];
        let (parts, style): (&[ExecArg], Option<LineArgs>) = match &self.style {
            ArgStyle::VsCode => (&only_file, Some(LineArgs::VsCode)),
            ArgStyle::JetBrains => (&only_file, Some(LineArgs::JetBrains)),
            ArgStyle::PathColonLine => (&only_file, Some(LineArgs::PathColonLine)),
            ArgStyle::Exec(parts) => (parts, None),
            ArgStyle::ExecWithLine(parts, l) => (parts, Some(*l)),
            ArgStyle::Template { .. } => unreachable!("handled by the early return above"),
        };
        let mut args = Vec::new();
        for p in parts {
            match p {
                ExecArg::Literal(s) => args.push(s.clone()),
                // The file is always its own argument, never spliced into another string.
                ExecArg::File => match (style, line.filter(|_| self.kind == OpenerKind::Editor)) {
                    (Some(LineArgs::VsCode), Some(n)) => args.extend([os("-g"), at_line(&file, n)]),
                    (Some(LineArgs::JetBrains), Some(n)) => args.extend([os("--line"), os(&n.to_string()), file.clone()]),
                    (Some(LineArgs::PathColonLine), Some(n)) => args.push(at_line(&file, n)),
                    _ => args.push(file.clone()),
                },
                // Flatpak's `@@u … @@` forwarding (minor #4): no line form, and never a bare path.
                ExecArg::FileUri => args.push(to_file_uri(&file)),
            }
        }
        LaunchCommand { program: self.program.clone(), args }
    }
}

/// Splits a desktop entry's `Exec` value (Desktop Entry Specification, "The Exec key") into the
/// program and its arguments. Field codes: the first `%f`/`%F`/`%u`/`%U` becomes `ExecArg::File`
/// (appended when there's none), the others are dropped, and `%%` is a literal `%`. `None` for
/// an empty or unbalanced line.
pub fn parse_exec(exec: &str) -> Option<(String, Vec<ExecArg>)> {
    // Unquoted whitespace separates; inside double quotes, `\` escapes the next character
    // (the spec allows it before `"`, `` ` ``, `$` and `\`).
    let mut tokens: Vec<String> = Vec::new();
    let mut cur: Option<String> = None;
    let mut in_quotes = false;
    let mut chars = exec.chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => {
                in_quotes = !in_quotes;
                cur.get_or_insert_with(String::new);
            }
            '\\' if in_quotes => cur.get_or_insert_with(String::new).push(chars.next()?),
            c if c.is_whitespace() && !in_quotes => tokens.extend(cur.take()),
            c => cur.get_or_insert_with(String::new).push(c),
        }
    }
    if in_quotes {
        return None;
    }
    tokens.extend(cur.take());
    let mut it = tokens.into_iter();
    let program = it.next().filter(|p| !p.is_empty() && !p.contains('%'))?;
    let mut args = Vec::new();
    let mut file = false;
    for t in it {
        if matches!(t.as_str(), "%f" | "%F" | "%u" | "%U") {
            if !file {
                args.push(ExecArg::File);
                file = true;
            }
            continue;
        }
        // A file code embedded in a larger argument (`--file=%f`, `sh -c "geany %F"`) isn't a
        // standalone argument, so the Desktop Entry Specification's field-code rule doesn't
        // cover it. Never splice the path into a string — for `sh -c "... %F"` that's a classic
        // injection, running the opened file as a shell command — so treat the whole entry as
        // unsupported (not runnable) instead of just dropping this one argument.
        if has_file_code(&t) {
            return None;
        }
        // Other codes (%i %c %k, the deprecated %d %D %n %N %v %m, unknown ones) are dropped.
        let mut out = String::new();
        let mut cs = t.chars();
        while let Some(c) = cs.next() {
            if c != '%' {
                out.push(c);
            } else if cs.next() == Some('%') {
                out.push('%');
            }
        }
        if !out.is_empty() {
            args.push(ExecArg::Literal(out.into()));
        }
    }
    if !file {
        args.push(ExecArg::File);
    }
    Some((program, args))
}

/// Whether `t` holds a `%f`/`%F`/`%u`/`%U` (not a `%%`-escaped one).
fn has_file_code(t: &str) -> bool {
    let mut cs = t.chars();
    while let Some(c) = cs.next() {
        if c == '%' && matches!(cs.next(), Some('f' | 'F' | 'u' | 'U')) {
            return true;
        }
    }
    false
}

/// Splits a custom editor command template into words: whitespace-separated, with `'…'`, `"…"`
/// and backslash escapes (a permissive shell-like quoting — this is the user's own command line,
/// not a desktop entry's `%`-code `Exec` syntax). Each word keeps its `{file}`/`{line}`/`{repo}`
/// placeholders literally; `Opener::command` substitutes them per open, never through a shell.
fn tokenize_template(template: &str) -> Result<Vec<String>, GbError> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut in_word = false;
    let mut chars = template.chars();
    while let Some(c) = chars.next() {
        match c {
            '\'' | '"' => {
                in_word = true;
                let mut closed = false;
                while let Some(d) = chars.next() {
                    if d == c {
                        closed = true;
                        break;
                    }
                    if d == '\\' && c == '"' {
                        if let Some(e) = chars.next() {
                            cur.push(e);
                        }
                    } else {
                        cur.push(d);
                    }
                }
                if !closed {
                    return Err(GbError::new(GbErrorKind::InvalidInput, "unterminated quote in the editor command"));
                }
            }
            '\\' => {
                in_word = true;
                if let Some(e) = chars.next() {
                    cur.push(e);
                }
            }
            c if c.is_whitespace() => {
                if in_word {
                    out.push(std::mem::take(&mut cur));
                    in_word = false;
                }
            }
            c => {
                in_word = true;
                cur.push(c);
            }
        }
    }
    if in_word {
        out.push(cur);
    }
    Ok(out)
}

/// Substitutes `{file}`, `{line}` and `{repo}` in `word` in one left-to-right pass (fix round 1,
/// item 4): each placeholder is replaced as it's found in the *original* word, and the cursor
/// moves past the inserted text without ever re-scanning it. Chained `.replace()` calls don't have
/// this property — replacing `{file}` first, then `{repo}`, would re-scan the just-inserted file
/// text and (wrongly) substitute a `{repo}` that happened to appear inside the file's own name.
fn substitute_template_word(word: &str, file: &str, line: &str, repo: &str) -> String {
    let mut out = String::with_capacity(word.len());
    let mut rest = word;
    'outer: while !rest.is_empty() {
        for (placeholder, value) in [("{file}", file), ("{line}", line), ("{repo}", repo)] {
            if let Some(after) = rest.strip_prefix(placeholder) {
                out.push_str(value);
                rest = after;
                continue 'outer;
            }
        }
        let mut chars = rest.chars();
        out.push(chars.next().expect("rest is non-empty"));
        rest = chars.as_str();
    }
    out
}

/// Builds the custom editor opener (R5: the settings' "Custom" editor choice) for one repository.
/// `template`'s first word is the program (resolved exactly as a detected editor's `TryExec` is:
/// an absolute, executable path, or a bare name on `env`'s `PATH`); the rest keeps its
/// placeholders for `Opener::command` to fill in per open. `repo` is baked in now because
/// `ArgStyle::Template` carries it (see its docs).
pub fn template_opener(id: impl Into<String>, name: impl Into<String>, template: &str, repo: impl Into<PathBuf>, env: &DetectEnv) -> Result<Opener, GbError> {
    let mut words = tokenize_template(template)?;
    if words.is_empty() {
        return Err(GbError::new(GbErrorKind::InvalidInput, "empty editor command"));
    }
    let program_word = words.remove(0);
    if is_shell_program(&program_word) && shell_c_script_has_placeholder(&words) {
        return Err(GbError::new(
            GbErrorKind::InvalidInput,
            "a shell or interpreter's code argument can't contain {file}, {line} or {repo}: pass them as separate arguments after the code instead",
        ));
    }
    let program = resolve_program(env, &program_word).ok_or_else(|| GbError::new(GbErrorKind::NotFound, format!("editor command not found: {program_word}")))?;
    Ok(Opener::new(id, name, OpenerKind::Editor, program, ArgStyle::Template { words, repo: repo.into() }))
}

/// Programs that run a code argument (`sh -c <script>`, `python -c`, `perl -e`, `node --eval`…).
/// `env` is included since `env [VAR=…] sh -c …` is a common way to invoke one indirectly; the
/// check below finds the code flag whichever of these named it.
const SHELL_PROGRAMS: &[&str] = &[
    "sh", "bash", "zsh", "dash", "fish", "ksh", "mksh", "csh", "tcsh", "ash", "busybox", "env", "perl", "ruby", "node", "nodejs",
    "php", "lua", "tclsh", "pwsh", "osascript",
];

fn is_shell_program(word: &str) -> bool {
    let base = word.rsplit(['/', '\\']).next().unwrap_or(word);
    SHELL_PROGRAMS.contains(&base) || base.starts_with("python")
}

const TEMPLATE_PLACEHOLDERS: [&str; 3] = ["{file}", "{line}", "{repo}"];

/// An option word that makes the next argument (or its own attached value) code: a short
/// cluster holding `c`/`e`/`E`/`r` (`-c`, `-lc`, `-ec`, `-e`, `-r` for php) or a long form
/// (`--command`, `--eval`, `--exec`, `--execute`, with or without `=value`).
fn is_code_flag(word: &str) -> bool {
    if let Some(long) = word.strip_prefix("--") {
        let name = long.split('=').next().unwrap_or(long);
        return matches!(name, "command" | "eval" | "exec" | "execute");
    }
    match word.strip_prefix('-') {
        Some(short) if !short.is_empty() => {
            let letters: String = short.chars().take_while(|c| c.is_ascii_alphabetic()).collect();
            letters.chars().any(|c| matches!(c, 'c' | 'e' | 'E' | 'r'))
        }
        _ => false,
    }
}

/// I1's rule (desktop entries), adapted to the custom template, for a program that runs code
/// (`SHELL_PROGRAMS`): a placeholder is safe only as its own whole word that isn't code. It's
/// refused when it's embedded in a larger word (`"vim {file}"`, `-c{file}`, `--eval={file}`), or
/// when it's the word right after a code flag (`-c {file}`, `-lc {file}`, `--command {file}`),
/// since either way a crafted file name or repository path could run arbitrary commands.
/// `sh -c 'ed "$1"' sh {file}` stays allowed: the path is a positional argument, not code.
fn shell_c_script_has_placeholder(words: &[String]) -> bool {
    let has = |w: &str| TEMPLATE_PLACEHOLDERS.iter().any(|p| w.contains(p));
    let whole = |w: &str| TEMPLATE_PLACEHOLDERS.contains(&w);
    words.iter().any(|w| has(w) && !whole(w)) || words.windows(2).any(|w| is_code_flag(&w[0]) && has(&w[1]))
}

/// The desktop entry id that handles a MIME type (`xdg-mime query default`).
pub type MimeDefault = Box<dyn Fn(&str) -> Option<String> + Send + Sync>;

/// Where detection looks. `from_system` reads the real environment; tests build their own.
pub struct DetectEnv {
    /// `$PATH`, in order.
    pub path: Vec<PathBuf>,
    pub home: Option<PathBuf>,
    /// `$XDG_DATA_HOME` then `$XDG_DATA_DIRS` (Flatpak's and Snap's exports are listed there):
    /// each may have an `applications/` directory. Earlier directories take precedence.
    pub data_dirs: Vec<PathBuf>,
    /// The desktop entry id (`org.gnome.Nautilus.desktop`) that handles a MIME type.
    pub mime_default: MimeDefault,
    /// GitBolt's own executable: an entry that runs it is never offered.
    pub self_exe: Option<PathBuf>,
}

impl DetectEnv {
    pub fn from_system() -> Self {
        let path: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).filter(|d| d.is_absolute()).collect()).unwrap_or_default();
        let home = std::env::var_os("HOME").map(PathBuf::from).filter(|h| h.is_absolute());
        let data_home = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).or_else(|| home.as_ref().map(|h| h.join(".local/share")));
        let mut data_dirs: Vec<PathBuf> = std::env::var_os("XDG_DATA_DIRS")
            .map(|d| std::env::split_paths(&d).filter(|p| p.is_absolute()).collect::<Vec<_>>())
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| vec![PathBuf::from("/usr/local/share"), PathBuf::from("/usr/share")]);
        // Flatpak's and Snap's exports, in case the session didn't add them to XDG_DATA_DIRS.
        let exports = [home.as_ref().map(|h| h.join(".local/share/flatpak/exports/share")), Some("/var/lib/flatpak/exports/share".into()), Some("/var/lib/snapd/desktop".into())];
        for d in exports.into_iter().flatten() {
            if !data_dirs.contains(&d) {
                data_dirs.push(d);
            }
        }
        let xdg_mime = find_in_path(&path, "xdg-mime");
        Self {
            path,
            home,
            data_dirs: data_home.into_iter().chain(data_dirs).collect(),
            mime_default: Box::new(move |mime| xdg_mime.as_deref().and_then(|x| query_default(x, mime))),
            self_exe: std::env::current_exe().ok(),
        }
    }
}

/// `xdg-mime query default <mime>` (argv only), given two seconds.
fn query_default(xdg_mime: &Path, mime: &str) -> Option<String> {
    use std::io::Read;
    use std::process::{Command, Stdio};
    let mut child = Command::new(xdg_mime).args(["query", "default", mime]).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(Some(_)) | Err(_) => return None,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                return None;
            }
            Ok(None) => std::thread::sleep(std::time::Duration::from_millis(10)),
        }
    }
    let mut out = String::new();
    child.stdout.take()?.read_to_string(&mut out).ok()?;
    let id = out.lines().next()?.trim();
    (id.ends_with(".desktop") && !id.contains('/')).then(|| id.to_string())
}

#[cfg(unix)]
fn is_executable(p: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(p).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
}

#[cfg(not(unix))]
fn is_executable(p: &Path) -> bool {
    p.is_file()
}

fn find_in_path(path: &[PathBuf], name: &str) -> Option<PathBuf> {
    path.iter().map(|d| d.join(name)).find(|p| is_executable(p))
}

/// A desktop entry's program: an absolute executable, or a bare name found on `PATH`.
fn resolve_program(env: &DetectEnv, program: &str) -> Option<PathBuf> {
    if program.contains('/') {
        let p = PathBuf::from(program);
        (p.is_absolute() && is_executable(&p)).then_some(p)
    } else {
        find_in_path(&env.path, program)
    }
}

/// IntelliJ-platform IDEs, by launcher name (Toolbox script, `<name>` or `<name>.sh` on `PATH`,
/// and the product part of their desktop ids).
const JETBRAINS: &[(&str, &str)] = &[
    ("idea", "IntelliJ IDEA"),
    ("phpstorm", "PhpStorm"),
    ("webstorm", "WebStorm"),
    ("pycharm", "PyCharm"),
    ("goland", "GoLand"),
    ("clion", "CLion"),
    ("rider", "Rider"),
    ("rubymine", "RubyMine"),
    ("rustrover", "RustRover"),
    ("datagrip", "DataGrip"),
    ("dataspell", "DataSpell"),
];

/// The editors listed first, in this order (H32); then the rest alphabetically.
const KNOWN_ORDER: &[&str] = &["vscode", "vscodium", "jetbrains-", "sublime", "zed", "kate", "gedit", "gnome-text-editor"];

fn rank(o: &Opener) -> (usize, usize, String) {
    let known = KNOWN_ORDER.iter().position(|k| if k.ends_with('-') { o.id.starts_with(k) } else { o.id == *k }).unwrap_or(KNOWN_ORDER.len());
    let jb = o.id.strip_prefix("jetbrains-").and_then(|p| JETBRAINS.iter().position(|(k, _)| *k == p)).unwrap_or(0);
    (known, jb, o.name.to_lowercase())
}

/// Every opener found: text editors and IDEs (the known ones first), then the file manager.
pub fn detect(env: &DetectEnv) -> Vec<Opener> {
    #[cfg(unix)]
    let mut found = desktop::editors(env);
    #[cfg(not(unix))]
    let mut found: Vec<Opener> = Vec::new();

    // Launchers without a desktop entry (a Toolbox script, a tarball's `bin/` on PATH). The
    // desktop entry wins when both exist.
    let in_path = |names: &[&str]| names.iter().find_map(|n| find_in_path(&env.path, n));
    let mut supplement = |id: &str, name: &str, program: Option<PathBuf>, style: ArgStyle| {
        if let Some(p) = program.filter(|_| !found.iter().any(|o| o.id == id)) {
            found.push(Opener::new(id, name, OpenerKind::Editor, p, style));
        }
    };
    supplement("vscode", "VS Code", in_path(&["code"]), ArgStyle::VsCode);
    supplement("vscodium", "VSCodium", in_path(&["codium"]), ArgStyle::VsCode);
    let toolbox = env.home.as_ref().map(|h| h.join(".local/share/JetBrains/Toolbox/scripts"));
    for (key, name) in JETBRAINS {
        let script = toolbox.as_ref().map(|t| t.join(key)).filter(|p| is_executable(p));
        supplement(&format!("jetbrains-{key}"), name, script.or_else(|| in_path(&[key, &format!("{key}.sh")])), ArgStyle::JetBrains);
    }
    let opt_sublime = Some(PathBuf::from("/opt/sublime_text/sublime_text")).filter(|p| is_executable(p));
    supplement("sublime", "Sublime Text", in_path(&["subl", "sublime_text"]).or(opt_sublime), ArgStyle::PathColonLine);
    let local_zed = env.home.as_ref().map(|h| h.join(".local/bin/zed")).filter(|p| is_executable(p));
    supplement("zed", "Zed", in_path(&["zed", "zeditor"]).or(local_zed), ArgStyle::PathColonLine);
    found.sort_by_key(rank);

    // The `inode/directory` default, else `xdg-open` on the folder.
    #[cfg(unix)]
    let manager = (env.mime_default)("inode/directory").and_then(|id| desktop::entry_opener(env, &id, "file-manager", OpenerKind::FileManager));
    #[cfg(not(unix))]
    let manager: Option<Opener> = None;
    let manager = manager.or_else(|| find_in_path(&env.path, "xdg-open").map(|p| Opener::new("file-manager", "File manager", OpenerKind::FileManager, p, ArgStyle::Exec(vec![ExecArg::File]))));
    found.extend(manager);
    found
}

/// This OS's openers (the seam other OSes plug into; spec §4). Linux: XDG desktop entries,
/// Toolbox scripts and `PATH`.
pub fn detect_system() -> Vec<Opener> {
    #[cfg(target_os = "linux")]
    return detect(&DetectEnv::from_system());
    #[cfg(not(target_os = "linux"))]
    return Vec::new();
}

/// This OS's URL opener (spec §14.4: links in the default browser), or `None` where there's none
/// yet (spec §4). `hook` adjusts the launch's environment exactly as an opener's or the chooser's
/// fallback does (`ChildEnvHook`): without it, the browser would inherit whatever the app's own
/// runtime set for itself (`GDK_BACKEND=x11`, `IBUS_ENABLE_SYNC_MODE=1`), on top of
/// `CHROME_DEVEL_SANDBOX`, which `launch_command` always strips (`I2`). The caller
/// (`links::validate_web_url`, run before the API ever calls the opener) has already checked
/// `url` starts with `http(s)://` and has no userinfo, so it can never be read as an `xdg-open`
/// option.
pub fn system_url_opener(hook: ChildEnvHook) -> Option<UrlOpener> {
    #[cfg(target_os = "linux")]
    {
        let path: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).filter(|d| d.is_absolute()).collect()).unwrap_or_default();
        url_opener_using(&path, hook)
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = hook;
        None
    }
}

/// `system_url_opener`'s pure half, so tests can inject `$PATH` instead of the real one.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
fn url_opener_using(path: &[PathBuf], hook: ChildEnvHook) -> Option<UrlOpener> {
    let program = find_in_path(path, "xdg-open")?;
    Some(Arc::new(move |url: &str| spawn_detached_with(&LaunchCommand { program: program.clone(), args: vec![url.into()] }, &*hook)))
}

/// GitBolt's own environment variables, which must not leak into any child process it starts —
/// an opener, the chooser's `xdg-open` fallback, the URL opener, or git itself (another
/// Chromium-based app, e.g. VS Code, would pick up the sandbox helper path). `launch_command`
/// strips these unconditionally (even with a no-op hook, as the harness and tests use); so does
/// `GitCli::run` (`git.rs`), the other place a child process starts.
pub const PRIVATE_ENV: &[&str] = &["CHROME_DEVEL_SANDBOX", "GITBOLT_OPEN"];

/// Adjusts a launched app's environment. The app supplies it: it restores what its runtime
/// changed for itself (the vendored CEF runtime forces `GDK_BACKEND=x11`, so a GNOME app would
/// start under XWayland). The harness and tests launch nothing real and pass a no-op.
pub type ChildEnvHook = Arc<dyn Fn(&mut std::process::Command) + Send + Sync>;

/// The command that runs `cmd`: its argv (no shell), null stdio, its own process group,
/// GitBolt's own variables removed, then `hook`'s changes.
pub fn launch_command(cmd: &LaunchCommand, hook: &dyn Fn(&mut std::process::Command)) -> std::process::Command {
    use std::process::{Command, Stdio};
    let mut c = Command::new(&cmd.program);
    c.args(&cmd.args).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null());
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut c, 0);
    for var in PRIVATE_ENV {
        c.env_remove(var);
    }
    hook(&mut c);
    c
}

/// `spawn_detached_with` and no environment hook.
pub fn spawn_detached(cmd: &LaunchCommand) -> Result<(), GbError> {
    spawn_detached_with(cmd, &|_| {})
}

/// Starts `launch_command(cmd, hook)` detached, reaped by a thread so it never lingers as a
/// zombie.
pub fn spawn_detached_with(cmd: &LaunchCommand, hook: &dyn Fn(&mut std::process::Command)) -> Result<(), GbError> {
    let mut c = launch_command(cmd, hook);
    let mut child = c.spawn().map_err(|e| GbError::new(GbErrorKind::Io, format!("couldn't start {}: {e}", cmd.program.display())))?;
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn os(s: &str) -> OsString {
    OsStr::new(s).to_owned()
}

/// `<file>:<line>`, the form VS Code's `-g`, Sublime Text and Zed take.
fn at_line(file: &OsStr, n: u32) -> OsString {
    let mut s = file.to_owned();
    s.push(format!(":{n}"));
    s
}

/// `file://` plus a percent-encoded path (minor #4): what Flatpak's `@@u … @@` forwarding needs,
/// since the document portal (which exports the file into the sandbox) takes a URI, not a path.
/// On unix this operates on the path's raw bytes (fix round 1, item 9), so a non-UTF-8 name's
/// exact bytes reach the URI instead of a lossy `to_string_lossy()` replacement pointing at the
/// wrong path.
#[cfg(unix)]
fn to_file_uri(file: &OsStr) -> OsString {
    use std::os::unix::ffi::OsStrExt;
    percent_encode_file_uri(file.as_bytes())
}

/// Without direct byte access to `OsStr` (non-unix), this falls back to a lossy conversion: a
/// worse but still-functional URI for the rare non-UTF-8 name, on a platform Flatpak (the only
/// caller of `ExecArg::FileUri`) doesn't target anyway.
#[cfg(not(unix))]
fn to_file_uri(file: &OsStr) -> OsString {
    percent_encode_file_uri(file.to_string_lossy().as_bytes())
}

/// `file://` plus `bytes`, percent-encoded exactly (fix round 1, item 9): operating on the raw
/// bytes, not a lossy UTF-8 string, so a non-UTF-8 file name's exact bytes reach the URI instead
/// of the U+FFFD replacement character silently pointing at the wrong path.
fn percent_encode_file_uri(bytes: &[u8]) -> OsString {
    let mut out = String::from("file://");
    for &b in bytes {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    OsString::from(out)
}

#[cfg(test)]
pub(super) mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn lit(s: &str) -> ExecArg {
        ExecArg::Literal(s.into())
    }

    pub(super) fn args(c: &LaunchCommand) -> Vec<String> {
        c.args.iter().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn exec_lines_split_into_program_and_arguments() {
        assert_eq!(parse_exec(r#""/home/u/.local/share/JetBrains/Toolbox/apps/phpstorm/bin/phpstorm" %u"#), Some(("/home/u/.local/share/JetBrains/Toolbox/apps/phpstorm/bin/phpstorm".into(), vec![ExecArg::File])));
        assert_eq!(parse_exec("nautilus --new-window %U"), Some(("nautilus".into(), vec![lit("--new-window"), ExecArg::File])));
        // No field code: the file goes last.
        assert_eq!(parse_exec("gedit"), Some(("gedit".into(), vec![ExecArg::File])));
        // Only the first file code counts; icon/name/location codes are dropped; %% is a literal %.
        assert_eq!(parse_exec("ed %i %c %k %f %F 100%%"), Some(("ed".into(), vec![ExecArg::File, lit("100%")])));
        // Quoting: spaces and escaped characters stay inside one argument.
        assert_eq!(parse_exec(r#""/opt/My Editor/bin/ed" "--title=a \"b\" \\ \$c" %f"#), Some(("/opt/My Editor/bin/ed".into(), vec![lit(r#"--title=a "b" \ $c"#), ExecArg::File])));
        assert_eq!(parse_exec(""), None);
        assert_eq!(parse_exec("\"unbalanced %f"), None);
    }

    #[test]
    fn each_style_opens_the_file_at_the_line() {
        let f = Path::new("/repo/src/a b.php");
        let code = Opener::new("vscode", "VS Code", OpenerKind::Editor, "/usr/bin/code", ArgStyle::VsCode);
        assert_eq!(args(&code.command(f, Some(12))), ["-g", "/repo/src/a b.php:12"]);
        assert_eq!(args(&code.command(f, None)), ["/repo/src/a b.php"]);
        assert_eq!(code.command(f, None).program, Path::new("/usr/bin/code"));
        let jb = Opener::new("jetbrains-phpstorm", "PhpStorm", OpenerKind::Editor, "/t/phpstorm", ArgStyle::JetBrains);
        assert_eq!(args(&jb.command(f, Some(7))), ["--line", "7", "/repo/src/a b.php"]);
        assert_eq!(args(&jb.command(f, None)), ["/repo/src/a b.php"]);
        let zed = Opener::new("zed", "Zed", OpenerKind::Editor, "/usr/bin/zed", ArgStyle::PathColonLine);
        assert_eq!(args(&zed.command(f, Some(3))), ["/repo/src/a b.php:3"]);
        let text = Opener::new("text-editor", "Text Editor", OpenerKind::Editor, "/usr/bin/gnome-text-editor", ArgStyle::Exec(vec![lit("--standalone"), ExecArg::File, lit("-x")]));
        assert_eq!(args(&text.command(f, Some(3))), ["--standalone", "/repo/src/a b.php", "-x"], "an Exec opener takes no line");
        let files = Opener::new("file-manager", "Files", OpenerKind::FileManager, "/usr/bin/nautilus", ArgStyle::Exec(vec![lit("--new-window"), ExecArg::File]));
        assert_eq!(args(&files.command(Path::new("/repo/src"), Some(3))), ["--new-window", "/repo/src"]);
    }

    /// Minor #4: a `FileUri` field code becomes a percent-encoded `file://` URI, not a path.
    #[test]
    fn file_uri_args_are_percent_encoded_uris() {
        let flatpak = Opener::new(
            "jetbrains-idea",
            "IntelliJ IDEA",
            OpenerKind::Editor,
            "/usr/bin/flatpak",
            ArgStyle::Exec(vec![lit("run"), lit("--command=idea"), lit("@@u"), ExecArg::FileUri, lit("@@")]),
        );
        assert_eq!(args(&flatpak.command(Path::new("/repo/src/a b.php"), Some(5))), ["run", "--command=idea", "@@u", "file:///repo/src/a%20b.php", "@@"], "no line form for a URI code either");
    }

    /// Fix round 1, item 9: a non-UTF-8 file name's exact bytes must reach the URI, not the
    /// U+FFFD replacement `to_string_lossy()` would substitute (which would point at the wrong
    /// path entirely).
    #[test]
    fn file_uri_preserves_non_utf8_bytes_exactly() {
        use std::os::unix::ffi::OsStringExt;
        let raw = std::ffi::OsString::from_vec(vec![b'/', b'a', 0xFF, b'.', b't', b'x', b't']);
        let opener = Opener::new("x", "X", OpenerKind::Editor, "/usr/bin/x", ArgStyle::Exec(vec![ExecArg::FileUri]));
        let c = opener.command(Path::new(&raw), None);
        assert_eq!(args(&c), ["file:///a%FF.txt"]);
    }

    #[test]
    fn a_custom_template_substitutes_file_line_and_repo() {
        let tmp = tempfile::tempdir().unwrap();
        executable(&tmp.path().join("bin/zz"));
        let env = DetectEnv { path: vec![tmp.path().join("bin")], home: None, data_dirs: vec![], mime_default: Box::new(|_| None), self_exe: None };
        let o = template_opener("custom", "Custom", r#"zz --repo="{repo}" "{file}:{line}""#, tmp.path().join("work/repo"), &env).unwrap();
        assert_eq!(o.program(), tmp.path().join("bin/zz"));
        let c = o.command(Path::new("/w/a b.php"), Some(9));
        assert_eq!(c.program, tmp.path().join("bin/zz"));
        assert_eq!(args(&c), [format!("--repo={}", tmp.path().join("work/repo").display()), "/w/a b.php:9".into()]);
        // No line: the template's `{line}` becomes `1`, like opening at the top of the file.
        assert_eq!(args(&o.command(Path::new("/w/a b.php"), None)).last().unwrap(), "/w/a b.php:1");
    }

    /// Minor #4 (fix round 1, item 4): chained `.replace()` calls re-scan already-substituted
    /// text, so a file whose name literally contains `{repo}` would get double-substituted. One
    /// left-to-right pass must never look at text it just inserted.
    #[test]
    fn template_substitution_never_rescans_inserted_text() {
        let tmp = tempfile::tempdir().unwrap();
        executable(&tmp.path().join("zz"));
        let env = DetectEnv { path: vec![tmp.path().to_path_buf()], home: None, data_dirs: vec![], mime_default: Box::new(|_| None), self_exe: None };
        let o = template_opener("custom", "Custom", "zz {file} {repo}", "/r{file}", &env).unwrap();
        let c = o.command(Path::new("/w/x{repo}.txt"), Some(3));
        assert_eq!(args(&c), ["/w/x{repo}.txt", "/r{file}"], "neither substitution re-triggers on the other's output");
    }

    #[test]
    fn a_custom_template_with_no_such_program_is_not_found() {
        let env = DetectEnv { path: vec![], home: None, data_dirs: vec![], mime_default: Box::new(|_| None), self_exe: None };
        let err = template_opener("custom", "Custom", "nope {file}", "/repo", &env).unwrap_err();
        assert_eq!(err.kind, GbErrorKind::NotFound);
        let err = template_opener("custom", "Custom", "  ", "/repo", &env).unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
        let err = template_opener("custom", "Custom", r#"ed "unterminated {file}"#, "/repo", &env).unwrap_err();
        assert_eq!(err.kind, GbErrorKind::InvalidInput);
    }

    /// I1's rule, applied to the custom template: a placeholder can never sit inside a shell's
    /// `-c` script, whole-word or embedded, since that argument is parsed as shell code.
    #[test]
    fn a_shell_c_script_holding_a_placeholder_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["sh", "bash"] {
            executable(&tmp.path().join(name));
        }
        let env = DetectEnv { path: vec![tmp.path().to_path_buf()], home: None, data_dirs: vec![], mime_default: Box::new(|_| None), self_exe: None };
        let embedded = template_opener("custom", "Custom", r#"sh -c "geany {file}""#, "/repo", &env).unwrap_err();
        assert_eq!(embedded.kind, GbErrorKind::InvalidInput);
        let whole_word = template_opener("custom", "Custom", r#"sh -c "{file}""#, "/repo", &env).unwrap_err();
        assert_eq!(whole_word.kind, GbErrorKind::InvalidInput);
        let other_shell = template_opener("custom", "Custom", r#"bash -c "echo {line}""#, "/repo", &env).unwrap_err();
        assert_eq!(other_shell.kind, GbErrorKind::InvalidInput);
        // A placeholder outside the -c script (its own argument, becoming a positional parameter)
        // is still safe and accepted, exactly like the desktop-entry precedent.
        template_opener("custom", "Custom", r#"sh -c 'ed "$1"' sh {file}"#, "/repo", &env).unwrap();
        // A non-shell program is never checked at all.
        executable(&tmp.path().join("zz"));
        template_opener("custom", "Custom", "zz -c {file}", "/repo", &env).unwrap();
    }

    /// The code flag isn't always a bare `-c`: option clusters, long forms, attached values and
    /// other interpreters (python, perl, node…), reached directly or through `env`, are refused too.
    #[test]
    fn every_code_flag_form_holding_a_placeholder_is_rejected() {
        let tmp = tempfile::tempdir().unwrap();
        for name in ["sh", "bash", "fish", "env", "python3", "perl", "node", "php"] {
            executable(&tmp.path().join(name));
        }
        let env = DetectEnv { path: vec![tmp.path().to_path_buf()], home: None, data_dirs: vec![], mime_default: Box::new(|_| None), self_exe: None };
        for template in [
            r#"bash -lc "vim {file}""#,
            r#"bash -ec {file}"#,
            r#"fish --command "vim {file}""#,
            r#"sh -c{file}"#,
            r#"env FOO=1 bash -lc "vim {file}""#,
            r#"python3 -c "import os; os.system('vim {file}')""#,
            r#"perl -e "system('vim', '{file}')""#,
            r#"node --eval={file}"#,
            r#"php -r "{file}""#,
        ] {
            let err = template_opener("custom", "Custom", template, "/repo", &env).expect_err(template);
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "{template}");
        }
        // Positional arguments after the code stay allowed.
        template_opener("custom", "Custom", r#"bash -lc 'vim "$1"' bash {file}"#, "/repo", &env).unwrap();
        template_opener("custom", "Custom", r#"python3 -c 'import sys; print(sys.argv[1])' {file}"#, "/repo", &env).unwrap();
    }

    #[test]
    fn tokenize_template_handles_quotes_and_escapes() {
        assert_eq!(tokenize_template(r#"code --goto "{file}:{line}""#).unwrap(), vec!["code", "--goto", "{file}:{line}"]);
        assert_eq!(tokenize_template(r"ed \{literal\}").unwrap(), vec!["ed", "{literal}"]);
        assert_eq!(tokenize_template("'single word' plain").unwrap(), vec!["single word", "plain"]);
        assert_eq!(tokenize_template("").unwrap(), Vec::<String>::new());
    }

    pub(super) fn executable(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    /// Writes `dir/applications/<id>` (`id` may hold a subdirectory).
    pub(super) fn desktop(dir: &Path, id: &str, body: &str) {
        let path = dir.join("applications").join(id);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn exec_field_codes_are_expanded_dropped_or_refused_as_the_spec_says() {
        // Deprecated (%d %D %n %N %v %m) and unknown (%z) codes are dropped.
        assert_eq!(parse_exec("ed %d %D %n %N %v %m %z -x %F"), Some(("ed".into(), vec![lit("-x"), ExecArg::File])));
        // A file code inside a larger argument is never spliced into that argument: the whole
        // entry is refused (not runnable), not silently repaired by dropping the argument.
        assert_eq!(parse_exec("ed --file=%f --y"), None, "an embedded field code makes the entry unsupported");
        assert_eq!(parse_exec("ed 100%%f"), Some(("ed".into(), vec![lit("100%f"), ExecArg::File])), "an escaped %% is not a code");
        // Flatpak's file forwarding keeps its markers around the file.
        assert_eq!(
            parse_exec("/usr/bin/flatpak run --command=code com.visualstudio.code @@ %F @@"),
            Some(("/usr/bin/flatpak".into(), vec![lit("run"), lit("--command=code"), lit("com.visualstudio.code"), lit("@@"), ExecArg::File, lit("@@")]))
        );
        // A program can't be a field code.
        assert_eq!(parse_exec("%f"), None);
    }

    /// I1 regression: an `Exec` line that wraps the opened file in a shell (a common way to set
    /// environment variables for an editor) must never be offered, since the field code isn't
    /// its own argument and splicing it in would let the opened file run as a shell command.
    #[test]
    fn a_field_code_wrapped_in_a_shell_argument_is_rejected() {
        assert_eq!(parse_exec(r#"sh -c "GTK_THEME=Adwaita:dark geany %F""#), None, "sh -c \"... %F\" must be refused, not turned into `sh -c <path>`");
        assert_eq!(parse_exec(r#"sh -c "geany %F""#), None);
        // A normal, standalone field code still works.
        assert_eq!(parse_exec("code %F"), Some(("code".into(), vec![ExecArg::File])));
        // A shell wrapper is still accepted when the file is its own token (`%f`), not spliced
        // into another argument.
        let (program, args) = parse_exec(r#"sh -c 'ed "$1"' sh %f"#).expect("the file is its own argument, so this is runnable");
        assert_eq!(program, "sh");
        assert_eq!(args.iter().filter(|a| **a == ExecArg::File).count(), 1, "the file appears exactly once, as its own argument: {args:?}");
        // %% still escapes to a literal % rather than being seen as an embedded field code.
        assert_eq!(parse_exec("ed --level=100%%"), Some(("ed".into(), vec![lit("--level=100%"), ExecArg::File])));
    }

    #[test]
    fn toolbox_scripts_and_path_supplement_the_desktop_entries_and_the_file_manager_comes_last() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path();
        let (bin, home, data, sys) = (root.join("bin"), root.join("home"), root.join("home/.local/share"), root.join("usr/share"));
        executable(&bin.join("code"));
        executable(&bin.join("nautilus"));
        executable(&bin.join("webstorm.sh"));
        // Not executable: ignored.
        std::fs::write(bin.join("subl"), "").unwrap();
        executable(&data.join("JetBrains/Toolbox/scripts/phpstorm"));
        desktop(&sys, "org.gnome.Nautilus.desktop", "[Desktop Entry]\nType=Application\nName=Files\nExec=nautilus --new-window %U\nCategories=GNOME;Utility;Core;FileManager;\n");
        let env = DetectEnv {
            path: vec![bin.clone()],
            home: Some(home),
            data_dirs: vec![data, sys],
            mime_default: Box::new(|mime| (mime == "inode/directory").then(|| "org.gnome.Nautilus.desktop".into())),
            self_exe: None,
        };
        let found = detect(&env);
        let summary: Vec<(&str, &str, OpenerKind)> = found.iter().map(|o| (o.id.as_str(), o.name.as_str(), o.kind)).collect();
        assert_eq!(summary, [
            ("vscode", "VS Code", OpenerKind::Editor),
            ("jetbrains-phpstorm", "PhpStorm", OpenerKind::Editor),
            ("jetbrains-webstorm", "WebStorm", OpenerKind::Editor),
            ("file-manager", "Files", OpenerKind::FileManager),
        ]);
        assert_eq!(found[0].program(), bin.join("code"));
        assert_eq!(found[1].program(), root.join("home/.local/share/JetBrains/Toolbox/scripts/phpstorm"));
        assert_eq!(found[2].program(), bin.join("webstorm.sh"));
        assert_eq!(args(&found[3].command(Path::new("/r/src"), Some(3))), ["--new-window", "/r/src"]);
    }

    #[test]
    fn xdg_open_is_the_fallback_file_manager() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        executable(&bin.join("xdg-open"));
        let env = DetectEnv { path: vec![bin.clone()], home: None, data_dirs: vec![], mime_default: Box::new(|_| None), self_exe: None };
        let found = detect(&env);
        assert_eq!(found.len(), 1);
        assert_eq!((found[0].id.as_str(), found[0].name.as_str()), ("file-manager", "File manager"));
        assert_eq!(found[0].program(), bin.join("xdg-open"));
        assert_eq!(args(&found[0].command(Path::new("/r"), None)), ["/r"]);
    }

    /// I2: no `xdg-open` on `PATH` means no URL opener, same as the file-manager fallback.
    #[test]
    fn no_url_opener_without_xdg_open() {
        assert!(url_opener_using(&[], Arc::new(|_| {})).is_none());
    }

    /// I2 regression: opening a URL must go through the same argv-only, detached launch and
    /// `ChildEnvHook` as an opener or the chooser's `xdg-open` fallback — not bypass it the way
    /// `tauri_plugin_opener::open_url` used to, leaking `GDK_BACKEND=x11`,
    /// `IBUS_ENABLE_SYNC_MODE` and `CHROME_DEVEL_SANDBOX` into the browser.
    #[test]
    fn system_url_opener_launches_xdg_open_with_the_url_and_the_hooks_environment() {
        let tmp = tempfile::tempdir().unwrap();
        let bin = tmp.path().join("bin");
        let out = bin.join("out");
        std::fs::create_dir_all(&bin).unwrap();
        std::fs::write(bin.join("xdg-open"), format!("#!/bin/sh\nprintf '%s|%s' \"$1\" \"${{GDK_BACKEND-unset}}\" > '{}'\n", out.display())).unwrap();
        std::fs::set_permissions(bin.join("xdg-open"), std::fs::Permissions::from_mode(0o755)).unwrap();
        let hook: ChildEnvHook = Arc::new(|c: &mut std::process::Command| {
            c.env("GDK_BACKEND", "wayland");
        });
        let opener = url_opener_using(std::slice::from_ref(&bin), hook).expect("xdg-open is on PATH");
        opener("https://example.com/x").unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let mut got = String::new();
        while std::time::Instant::now() < deadline {
            got = std::fs::read_to_string(&out).unwrap_or_default();
            if got.contains('|') {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert_eq!(got, "https://example.com/x|wayland");
    }

    /// `cargo test -p gitbolt-core this_machines_openers -- --ignored --nocapture` lists what the
    /// app would offer here (it only reads the disk and asks `xdg-mime`; nothing is launched).
    #[test]
    #[ignore = "reads this machine's editors"]
    fn this_machines_openers() {
        for o in detect_system() {
            eprintln!("{:<32} {:<24} {:?} {}", o.id, o.name, o.kind, o.program().display());
        }
    }

    /// Fix round 1: a launched app's environment goes through the app's hook (which restores
    /// what the CEF runtime changed, e.g. `GDK_BACKEND`), after GitBolt's own are removed.
    #[test]
    fn the_launch_command_is_argv_only_and_its_environment_goes_through_the_hook() {
        let cmd = LaunchCommand { program: "/usr/bin/gnome-text-editor".into(), args: vec!["/w/a b.txt".into()] };
        let hook = |c: &mut std::process::Command| {
            c.env("GDK_BACKEND", "wayland");
            c.env_remove("IBUS_ENABLE_SYNC_MODE");
        };
        let c = launch_command(&cmd, &hook);
        assert_eq!(c.get_program(), "/usr/bin/gnome-text-editor");
        assert_eq!(c.get_args().collect::<Vec<_>>(), ["/w/a b.txt"]);
        let envs: Vec<(String, Option<String>)> = c.get_envs().map(|(k, v)| (k.to_string_lossy().into_owned(), v.map(|v| v.to_string_lossy().into_owned()))).collect();
        for private in ["CHROME_DEVEL_SANDBOX", "GITBOLT_OPEN"] {
            assert!(envs.contains(&(private.into(), None)), "{private} removed: {envs:?}");
        }
        assert!(envs.contains(&("GDK_BACKEND".into(), Some("wayland".into()))), "the hook's change: {envs:?}");
        assert!(envs.contains(&("IBUS_ENABLE_SYNC_MODE".into(), None)));
        // No hook (the harness, tests): nothing but GitBolt's own is touched.
        let plain = launch_command(&cmd, &|_: &mut std::process::Command| {});
        assert_eq!(plain.get_envs().count(), PRIVATE_ENV.len());
    }

    #[test]
    fn nothing_found_is_an_empty_list() {
        let env = DetectEnv { path: vec![], home: None, data_dirs: vec![], mime_default: Box::new(|_| None), self_exe: None };
        assert!(detect(&env).is_empty());
    }

    /// Runs `touch` (not an application) to prove the argv reaches the program unchanged: a
    /// file name full of shell syntax is created literally, since no shell is involved.
    #[test]
    fn spawn_detached_passes_argv_without_a_shell() {
        let tmp = tempfile::tempdir().unwrap();
        let name = tmp.path().join("a; touch pwned $(id) `x` & b");
        let touch = ["/usr/bin/touch", "/bin/touch"].into_iter().map(PathBuf::from).find(|p| p.exists()).expect("touch");
        spawn_detached(&LaunchCommand { program: touch, args: vec![name.clone().into()] }).unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !name.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(name.exists());
        assert_eq!(std::fs::read_dir(tmp.path()).unwrap().count(), 1, "nothing else was created");
        let err = spawn_detached(&LaunchCommand { program: tmp.path().join("missing"), args: vec![] }).unwrap_err();
        assert_eq!(err.kind, GbErrorKind::Io);
    }
}
