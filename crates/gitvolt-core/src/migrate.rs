//! GitBolt to GitVolt (0.7.0). On GitVolt's first start, GitBolt's folders become GitVolt's: the
//! settings and profiles (and the window's place), the undo journal, forge cache and token file,
//! the caches and logs, and Chromium's profile (the UI's saved layout and unsent drafts). Forge
//! tokens in the keyring move when first used (gitvolt-forge's `tokens`).
//!
//! Each folder is renamed into place: one step on one disk, nothing to check. When that fails
//! (another disk, a file in use on Windows), the folder is copied beside its new place, the copy
//! is compared with the original file by file and put in place with a rename, and only then is
//! the original removed. A folder GitVolt already has is never merged into or overwritten, so a
//! second start does nothing. The app runs this after the single-instance guard (no other GitVolt
//! runs, and a running GitBolt took the launch: `instance::claim_from_env`) and before anything
//! opens the folders.

use crate::platform::fs as pfs;
use crate::{legacy, paths};
use std::io::Read;
use std::path::{Path, PathBuf};

/// One folder: GitBolt's `from` becomes GitVolt's `to`. `transient`: entries of `from`, by name,
/// that are removed rather than moved (the downloaded update, fetched again when needed).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Move {
    pub from: PathBuf,
    pub to: PathBuf,
    pub transient: Vec<&'static str>,
}

/// What became of one [`Move`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    /// GitBolt had no such folder.
    Nothing,
    /// GitVolt has its folder already: GitBolt's stays as it is (unless only transient entries
    /// are left in it, which go).
    AlreadyThere,
    /// Renamed into place.
    Moved,
    /// Copied, checked and put in place; `left`: the original, or part of it, is still there (its
    /// removal failed, or the copy's new name couldn't be flushed to disk first).
    Copied { left: bool },
    /// Not moved: GitBolt's folder is as it was, and GitVolt has none. Why.
    Failed(String),
    /// GitVolt's folder from a start whose move failed ([`NOT_MOVED`]) was set aside at `aside`
    /// (kept: it holds what that start wrote), and the move was made again: `outcome`.
    Retried { aside: PathBuf, outcome: Box<Outcome> },
}

/// The file in GitVolt's folder when a move failed and the app made the folder afresh: the next
/// start sets that folder aside and tries the move again.
pub const NOT_MOVED: &str = ".gitbolt-not-moved";


/// The base folders the app's folders are in.
#[derive(Debug, Clone)]
pub struct Bases {
    pub config: PathBuf,
    pub data: PathBuf,
    pub cache: PathBuf,
    /// Where Chromium's profile folder (named by the identifier) is; none when it's inside the
    /// cache folder (a `GITVOLT_DEV_DIRS` instance), which moves with it.
    pub profile: Option<PathBuf>,
}

impl Bases {
    /// This user's (`paths`). The runtime's default profile is `<user's cache>/<identifier>/cef`.
    pub fn system() -> Self {
        Self {
            config: paths::config_base(),
            data: paths::data_base(),
            cache: paths::cache_base().unwrap_or_else(std::env::temp_dir),
            profile: if paths::dev_dirs().is_some() { None } else { paths::cache_base() },
        }
    }
}

/// The moves, each folder once: on macOS the config and data folders are one
/// (`~/Library/Application Support/GitBolt`), on Windows the data and cache folders
/// (`%LOCALAPPDATA%\gitbolt`).
pub fn moves(b: &Bases) -> Vec<Move> {
    let none: &[&'static str] = &[];
    let mut wanted = vec![
        (b.config.join(legacy::APP_DIR), b.config.join(paths::APP_DIR), none),
        (b.data.join(legacy::APP_DIR), b.data.join(paths::APP_DIR), none),
        (b.cache.join(legacy::APP_DIR), b.cache.join(paths::APP_DIR), &["updates"][..]),
    ];
    if let Some(p) = &b.profile {
        wanted.push((p.join(legacy::IDENTIFIER), p.join(paths::IDENTIFIER), none));
    }
    let mut out: Vec<Move> = Vec::new();
    for (from, to, transient) in wanted {
        match out.iter().position(|m| m.from == from) {
            Some(i) => {
                for &t in transient {
                    if !out[i].transient.contains(&t) {
                        out[i].transient.push(t);
                    }
                }
            }
            None => out.push(Move { from, to, transient: transient.to_vec() }),
        }
    }
    out
}

/// Each move in turn; a failed one's new folder is marked to be tried again ([`mark_not_moved`]).
/// Only for a guarded start: the retry sets GitVolt's folder aside.
pub fn run(moves: &[Move]) -> Vec<(Move, Outcome)> {
    let rename = |a: &Path, b: &Path| std::fs::rename(a, b);
    moves
        .iter()
        .map(|m| {
            let outcome = move_dir(m, &rename);
            if matches!(outcome, Outcome::Failed(_)) {
                let _ = mark_not_moved(m);
            }
            (m.clone(), outcome)
        })
        .collect()
}

/// One move, renaming with `rename` (`std::fs::rename`; a test's fails on purpose).
pub fn move_dir(m: &Move, rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>) -> Outcome {
    if std::fs::symlink_metadata(&m.from).is_err() {
        return Outcome::Nothing;
    }
    if std::fs::symlink_metadata(&m.to).is_ok() {
        let marker = m.to.join(NOT_MOVED);
        if marker.is_file() {
            if marker_expired(&marker) {
                tracing::info!("{} stays where it is: GitVolt's folder was made {RETRY_FOR_DAYS} days ago and is in use since", m.from.display());
            } else {
                return retry(m, rename);
            }
        }
        drop_if_only_transient(m);
        return Outcome::AlreadyThere;
    }
    move_into_place(m, rename)
}

/// GitVolt's folder, made afresh after a failed move, set aside (under a new name beside it,
/// kept) while the move is made again; put back if it fails again.
fn retry(m: &Move, rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>) -> Outcome {
    let aside = aside_name(&m.to);
    if let Err(e) = rename(&m.to, &aside) {
        return Outcome::Failed(format!("couldn't set {} aside: {e}", m.to.display()));
    }
    match move_into_place(m, rename) {
        Outcome::Failed(why) => match std::fs::rename(&aside, &m.to) {
            Ok(()) => Outcome::Failed(why),
            Err(e) => Outcome::Failed(format!("{why}; GitVolt's folder stays at {}: {e}", aside.display())),
        },
        outcome => Outcome::Retried { aside, outcome: Box::new(outcome) },
    }
}

/// How long a marked folder is retried: by then the user lives in the new folder, and setting it
/// aside would hide a week of their changes.
const RETRY_FOR_DAYS: u64 = 7;

/// The marker is older (by its modification time) than [`RETRY_FOR_DAYS`].
fn marker_expired(marker: &Path) -> bool {
    std::fs::metadata(marker)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age > std::time::Duration::from_secs(RETRY_FOR_DAYS * 86400))
}

/// `<to>.not-moved-<unix seconds>`, numbered on if that's taken.
fn aside_name(to: &Path) -> PathBuf {
    let secs = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or_default();
    let name = to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    let base = to.with_file_name(format!("{name}.not-moved-{secs}"));
    let mut path = base.clone();
    for n in 2.. {
        if std::fs::symlink_metadata(&path).is_err() {
            break;
        }
        let mut numbered = base.clone().into_os_string();
        numbered.push(format!("-{n}"));
        path = numbered.into();
    }
    path
}

/// Marks `m.to` (made if missing) as made afresh after `m` failed ([`NOT_MOVED`]).
pub fn mark_not_moved(m: &Move) -> std::io::Result<()> {
    pfs::private_dir_builder(std::fs::DirBuilder::new().recursive(true)).create(&m.to)?;
    std::fs::write(m.to.join(NOT_MOVED), format!("{} couldn't be moved here; GitVolt tries again when it next starts.\n", m.from.display()))
}

/// `m.from` to `m.to`, which isn't there.
fn move_into_place(m: &Move, rename: &dyn Fn(&Path, &Path) -> std::io::Result<()>) -> Outcome {
    let copy = staging(&m.to);
    if std::fs::symlink_metadata(&copy).is_ok() {
        let _ = remove_tree(&copy); // a copy an interrupted start left
    }
    for name in &m.transient {
        let p = m.from.join(name);
        let _ = if p.is_dir() { std::fs::remove_dir_all(&p) } else { std::fs::remove_file(&p) };
    }
    if let Some(parent) = m.to.parent()
        && let Err(e) = std::fs::create_dir_all(parent)
    {
        return Outcome::Failed(format!("can't create {}: {e}", parent.display()));
    }
    if rename(&m.from, &m.to).is_ok() {
        return Outcome::Moved;
    }
    if let Err(e) = copy_tree(&m.from, &copy, &m.transient).and_then(|()| same_tree(&m.from, &copy, &m.transient)) {
        let _ = remove_tree(&copy);
        return Outcome::Failed(format!("couldn't copy {}: {e}", m.from.display()));
    }
    if let Err(e) = rename(&copy, &m.to) {
        let _ = remove_tree(&copy);
        return Outcome::Failed(format!("couldn't put the copy at {}: {e}", m.to.display()));
    }
    // The copy's new name on disk before the original goes: a power cut can't leave neither.
    if let Some(parent) = m.to.parent()
        && pfs::sync_dir(parent).is_err()
    {
        return Outcome::Copied { left: true };
    }
    Outcome::Copied { left: remove_tree(&m.from).is_err() }
}

/// The copy's place while it's checked: beside `to`, hidden (`.gitvolt.moving`).
fn staging(to: &Path) -> PathBuf {
    let name = to.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
    to.with_file_name(format!(".{name}.moving"))
}

/// A copy of ours, removed even where it holds read-only folders or files: each made writable first.
fn remove_tree(path: &Path) -> std::io::Result<()> {
    fn writable(path: &Path) {
        let Ok(meta) = std::fs::symlink_metadata(path) else { return };
        if meta.is_dir() {
            let _ = pfs::set_mode(path, 0o700);
            for entry in std::fs::read_dir(path).into_iter().flatten().flatten() {
                writable(&entry.path());
            }
        } else if meta.is_file() && meta.permissions().readonly() {
            let _ = pfs::set_mode(path, 0o600);
        }
    }
    writable(path);
    std::fs::remove_dir_all(path)
}

/// GitBolt's folder once GitVolt has its own: removed when nothing but transient entries is left
/// in it (a removal that failed part-way, e.g. an installer still running from `updates\`).
fn drop_if_only_transient(m: &Move) {
    if m.transient.is_empty() {
        return;
    }
    let Ok(entries) = std::fs::read_dir(&m.from) else { return };
    if entries.flatten().all(|e| m.transient.iter().any(|t| e.file_name() == *t)) {
        let _ = std::fs::remove_dir_all(&m.from);
    }
}

/// `from` into a new folder `to`, less the top-level entries named in `skip`: files with their
/// permission bits and times, links as links, folders with their permission bits and times;
/// anything else (a FIFO, a socket) is refused. Each file and folder is flushed to disk, since
/// the original is removed once the copy checks out. Folders are private until they're done.
fn copy_tree(from: &Path, to: &Path, skip: &[&str]) -> std::io::Result<()> {
    pfs::private_dir_builder(&mut std::fs::DirBuilder::new()).create(to)?;
    for entry in std::fs::read_dir(from)? {
        let entry = entry?;
        if skip.iter().any(|s| entry.file_name() == *s) {
            continue;
        }
        let (src, dst) = (entry.path(), to.join(entry.file_name()));
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            pfs::symlink(std::fs::read_link(&src)?.as_os_str(), &dst)?;
        } else if kind.is_dir() {
            copy_tree(&src, &dst, &[])?;
        } else if kind.is_file() {
            copy_file(&src, &dst)?;
        } else {
            return Err(std::io::Error::other(format!("{} isn't a file, a folder or a link", src.display())));
        }
    }
    let meta = std::fs::metadata(from)?;
    if let Ok(time) = meta.modified() {
        let _ = pfs::set_modified(to, time);
    }
    pfs::sync_dir(to)?;
    std::fs::set_permissions(to, meta.permissions())
}

/// One file through one handle (a read-only original's copy is made read-only only at the end).
fn copy_file(src: &Path, dst: &Path) -> std::io::Result<()> {
    let mut input = std::fs::File::open(src)?;
    let meta = input.metadata()?;
    let mut output = pfs::private_file(std::fs::OpenOptions::new().write(true).create_new(true)).open(dst)?;
    std::io::copy(&mut input, &mut output)?;
    if let Ok(time) = meta.modified() {
        let _ = output.set_modified(time);
    }
    output.sync_all()?;
    drop(output);
    std::fs::set_permissions(dst, meta.permissions())
}

/// Every entry of `a` (less `skip` at the top) is in `b`, the same: a file's bytes, a link's
/// target, a folder's entries.
fn same_tree(a: &Path, b: &Path, skip: &[&str]) -> std::io::Result<()> {
    for entry in std::fs::read_dir(a)? {
        let entry = entry?;
        if skip.iter().any(|s| entry.file_name() == *s) {
            continue;
        }
        let (x, y) = (entry.path(), b.join(entry.file_name()));
        let kind = entry.file_type()?;
        let same = if kind.is_symlink() {
            std::fs::read_link(&x)? == std::fs::read_link(&y)?
        } else if kind.is_dir() {
            same_tree(&x, &y, &[]).map(|()| true)?
        } else {
            same_file(&x, &y)?
        };
        if !same {
            return Err(std::io::Error::other(format!("{} differs in the copy", x.display())));
        }
    }
    Ok(())
}

fn same_file(x: &Path, y: &Path) -> std::io::Result<bool> {
    let (mut f, mut g) = (std::fs::File::open(x)?, std::fs::File::open(y)?);
    if f.metadata()?.len() != g.metadata()?.len() {
        return Ok(false);
    }
    let (mut p, mut q) = (vec![0u8; 64 * 1024], vec![0u8; 64 * 1024]);
    loop {
        let n = f.read(&mut p)?;
        if n == 0 {
            return Ok(true);
        }
        g.read_exact(&mut q[..n])?;
        if p[..n] != q[..n] {
            return Ok(false);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write(p: &Path, text: &str) {
        std::fs::create_dir_all(p.parent().unwrap()).unwrap();
        std::fs::write(p, text).unwrap();
    }

    fn mv(from: &Path, to: &Path, transient: &[&'static str]) -> Move {
        Move { from: from.to_path_buf(), to: to.to_path_buf(), transient: transient.to_vec() }
    }

    fn real(a: &Path, b: &Path) -> std::io::Result<()> {
        std::fs::rename(a, b)
    }

    #[test]
    fn nothing_to_move_when_gitbolt_never_ran() {
        let t = tempfile::tempdir().unwrap();
        let m = mv(&t.path().join("gitbolt"), &t.path().join("gitvolt"), &[]);
        assert_eq!(move_dir(&m, &real), Outcome::Nothing);
        assert!(!m.to.exists());
    }

    #[test]
    fn a_folder_is_renamed_into_place_without_its_transient_entries() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("cache/gitbolt"), t.path().join("cache/gitvolt"));
        write(&from.join("logs/gitbolt.2026-10-01.log"), "log");
        write(&from.join("updates/GitVolt_0.7.0_amd64.deb"), "package");
        write(&t.path().join("cache/.gitvolt.moving/stale.json"), "half");
        let m = mv(&from, &to, &["updates"]);
        assert_eq!(move_dir(&m, &real), Outcome::Moved);
        assert!(!t.path().join("cache/.gitvolt.moving").exists(), "an interrupted copy goes too");
        assert_eq!(std::fs::read_to_string(to.join("logs/gitbolt.2026-10-01.log")).unwrap(), "log");
        assert!(!to.join("updates").exists(), "the download isn't kept");
        assert!(!from.exists());
        assert_eq!(move_dir(&m, &real), Outcome::Nothing, "a second start does nothing");
    }

    #[test]
    fn a_folder_gitvolt_already_has_is_never_merged_or_overwritten() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("gitbolt"), t.path().join("gitvolt"));
        write(&from.join("settings.json"), "old");
        write(&to.join("settings.json"), "new");
        let m = mv(&from, &to, &["updates"]);
        assert_eq!(move_dir(&m, &real), Outcome::AlreadyThere);
        assert_eq!(std::fs::read_to_string(from.join("settings.json")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(to.join("settings.json")).unwrap(), "new");
    }

    #[test]
    fn what_a_failed_removal_left_goes_once_only_transient_entries_remain() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("gitbolt"), t.path().join("gitvolt"));
        write(&from.join("updates/GitVolt_0.7.0_x64-setup.exe"), "installer");
        std::fs::create_dir_all(&to).unwrap();
        assert_eq!(move_dir(&mv(&from, &to, &["updates"]), &real), Outcome::AlreadyThere);
        assert!(!from.exists());
    }

    /// The rename fails (another disk; a file in use on Windows): copied, compared, put in
    /// place, and only then is the original removed.
    #[test]
    fn a_folder_that_cant_be_renamed_is_copied_checked_and_then_removed() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("share/gitbolt"), t.path().join("share/gitvolt"));
        write(&from.join("forge-tokens"), "{\"version\":1}");
        write(&from.join("journal/abc/1.json"), "entry");
        write(&from.join("updates/x.deb"), "package");
        let week_ago = std::time::SystemTime::now() - std::time::Duration::from_secs(7 * 86400);
        pfs::set_modified(from.join("journal/abc/1.json"), week_ago).unwrap();
        pfs::set_modified(from.join("journal/abc"), week_ago).unwrap();
        write(&from.join("read-only"), "kept");
        pfs::set_mode(from.join("read-only"), 0o444).unwrap();
        #[cfg(unix)]
        {
            crate::platform::fs::set_mode(from.join("forge-tokens"), 0o600).unwrap();
            crate::platform::fs::set_mode(&from, 0o700).unwrap();
            crate::platform::fs::symlink(std::ffi::OsStr::new("host-1234"), &from.join("SingletonLock")).unwrap();
        }
        let folder = from.clone();
        let refuse_the_folder = move |a: &Path, b: &Path| if a == folder { Err(std::io::Error::other("cross-device link")) } else { std::fs::rename(a, b) };
        assert_eq!(move_dir(&mv(&from, &to, &["updates"]), &refuse_the_folder), Outcome::Copied { left: false });
        assert_eq!(std::fs::read_to_string(to.join("journal/abc/1.json")).unwrap(), "entry");
        assert_eq!(std::fs::metadata(to.join("journal/abc/1.json")).unwrap().modified().unwrap(), week_ago, "a week-old copy still ages out on time");
        assert_eq!(std::fs::metadata(to.join("journal/abc")).unwrap().modified().unwrap(), week_ago, "folders too (open_copy::clean)");
        assert_eq!(std::fs::read_to_string(to.join("read-only")).unwrap(), "kept");
        assert!(std::fs::metadata(to.join("read-only")).unwrap().permissions().readonly(), "a read-only file is copied and stays read-only");
        assert!(!to.join("updates").exists());
        assert!(!from.exists());
        assert!(!t.path().join("share/.gitvolt.moving").exists(), "no copy left beside it");
        #[cfg(unix)]
        {
            let mode = |p: &Path| crate::platform::fs::mode(&std::fs::symlink_metadata(p).unwrap()) & 0o777;
            assert_eq!(mode(&to.join("forge-tokens")), 0o600);
            assert_eq!(mode(&to), 0o700);
            assert_eq!(std::fs::read_link(to.join("SingletonLock")).unwrap(), Path::new("host-1234"));
        }
    }

    #[test]
    fn a_copy_that_cant_be_put_in_place_leaves_the_original_as_it_was() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("gitbolt"), t.path().join("gitvolt"));
        write(&from.join("settings.json"), "old");
        let never = |_: &Path, _: &Path| -> std::io::Result<()> { Err(std::io::Error::other("read-only")) };
        assert!(matches!(move_dir(&mv(&from, &to, &[]), &never), Outcome::Failed(_)));
        assert_eq!(std::fs::read_to_string(from.join("settings.json")).unwrap(), "old");
        assert!(!to.exists());
        assert!(!t.path().join(".gitvolt.moving").exists());
    }

    #[test]
    fn a_copy_an_interrupted_start_left_is_replaced() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("gitbolt"), t.path().join("gitvolt"));
        write(&from.join("settings.json"), "old");
        write(&t.path().join(".gitvolt.moving/stale.json"), "half");
        write(&t.path().join(".gitvolt.moving/sub/f"), "half");
        pfs::set_mode(t.path().join(".gitvolt.moving/sub"), 0o500).unwrap();
        let folder = from.clone();
        let refuse = move |a: &Path, b: &Path| if a == folder { Err(std::io::Error::other("busy")) } else { std::fs::rename(a, b) };
        assert_eq!(move_dir(&mv(&from, &to, &[]), &refuse), Outcome::Copied { left: false });
        assert!(!to.join("stale.json").exists());
        assert_eq!(std::fs::read_to_string(to.join("settings.json")).unwrap(), "old");
    }

    /// A start whose move failed made GitVolt's folder afresh: the next start sets it aside and
    /// moves GitBolt's again.
    #[test]
    fn a_failed_move_is_tried_again_next_start() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("gitbolt"), t.path().join("gitvolt"));
        write(&from.join("settings.json"), "old");
        let m = mv(&from, &to, &[]);
        let never = |_: &Path, _: &Path| -> std::io::Result<()> { Err(std::io::Error::other("busy")) };
        assert!(matches!(move_dir(&m, &never), Outcome::Failed(_)));
        mark_not_moved(&m).unwrap();
        write(&to.join("settings.json"), "fresh"); // what that start wrote
        let Outcome::Retried { aside, outcome } = move_dir(&m, &real) else { panic!("not tried again") };
        assert_eq!(*outcome, Outcome::Moved);
        assert_eq!(std::fs::read_to_string(to.join("settings.json")).unwrap(), "old");
        assert!(!to.join(NOT_MOVED).exists());
        assert!(!from.exists());
        assert_eq!(aside.parent(), Some(t.path()));
        assert!(aside.file_name().unwrap().to_string_lossy().starts_with("gitvolt.not-moved-"), "{aside:?}");
        assert_eq!(std::fs::read_to_string(aside.join("settings.json")).unwrap(), "fresh", "kept beside it");
        assert_eq!(move_dir(&m, &real), Outcome::Nothing);
    }

    #[test]
    fn a_retry_that_fails_again_puts_gitvolts_folder_back() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("gitbolt"), t.path().join("gitvolt"));
        write(&from.join("settings.json"), "old");
        let m = mv(&from, &to, &[]);
        mark_not_moved(&m).unwrap();
        write(&to.join("settings.json"), "fresh");
        let (folder, copy) = (from.clone(), t.path().join(".gitvolt.moving"));
        let refuse = move |a: &Path, b: &Path| if a == folder || a == copy { Err(std::io::Error::other("busy")) } else { std::fs::rename(a, b) };
        assert!(matches!(move_dir(&m, &refuse), Outcome::Failed(_)));
        assert_eq!(std::fs::read_to_string(to.join("settings.json")).unwrap(), "fresh");
        assert!(to.join(NOT_MOVED).exists(), "tried again at the next start");
        assert_eq!(std::fs::read_to_string(from.join("settings.json")).unwrap(), "old");
        let names: Vec<String> = std::fs::read_dir(t.path()).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(names.len(), 2, "nothing set aside or half-copied left: {names:?}");
    }

    /// A 0555 folder (or a read-only file on FAT) in the original doesn't keep it behind.
    #[cfg(unix)]
    #[test]
    fn a_read_only_original_is_removed_after_the_copy() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("gitbolt"), t.path().join("gitvolt"));
        write(&from.join("ro/f"), "x");
        pfs::set_mode(from.join("ro"), 0o555).unwrap();
        let folder = from.clone();
        let refuse = move |a: &Path, b: &Path| if a == folder { Err(std::io::Error::other("busy")) } else { std::fs::rename(a, b) };
        assert_eq!(move_dir(&mv(&from, &to, &[]), &refuse), Outcome::Copied { left: false });
        assert!(!from.exists());
    }

    #[cfg(unix)]
    #[test]
    fn the_marked_folder_is_made_private() {
        let t = tempfile::tempdir().unwrap();
        let m = mv(&t.path().join("gitbolt"), &t.path().join("gitvolt"), &[]);
        mark_not_moved(&m).unwrap();
        assert_eq!(pfs::mode(&std::fs::metadata(&m.to).unwrap()) & 0o777, 0o700);
    }

    /// A week on, the user lives in the new folder: GitBolt's stays, and no more retries.
    #[test]
    fn a_marker_older_than_a_week_ends_the_retries() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("gitbolt"), t.path().join("gitvolt"));
        write(&from.join("settings.json"), "old");
        let m = mv(&from, &to, &[]);
        mark_not_moved(&m).unwrap();
        write(&to.join("settings.json"), "fresh");
        let eight_days = std::time::SystemTime::now() - std::time::Duration::from_secs(8 * 86400);
        pfs::set_modified(to.join(NOT_MOVED), eight_days).unwrap();
        assert_eq!(move_dir(&m, &real), Outcome::AlreadyThere);
        assert_eq!(std::fs::read_to_string(from.join("settings.json")).unwrap(), "old");
        assert_eq!(std::fs::read_to_string(to.join("settings.json")).unwrap(), "fresh");
        let six_days = std::time::SystemTime::now() - std::time::Duration::from_secs(6 * 86400);
        pfs::set_modified(to.join(NOT_MOVED), six_days).unwrap();
        assert!(matches!(move_dir(&m, &real), Outcome::Retried { .. }), "still within the week");
    }

    #[test]
    fn a_set_aside_that_fails_leaves_everything_as_it_was() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("gitbolt"), t.path().join("gitvolt"));
        write(&from.join("settings.json"), "old");
        let m = mv(&from, &to, &[]);
        mark_not_moved(&m).unwrap();
        let target = to.clone();
        let refuse = move |a: &Path, b: &Path| if a == target { Err(std::io::Error::other("busy")) } else { std::fs::rename(a, b) };
        let Outcome::Failed(why) = move_dir(&m, &refuse) else { panic!("not refused") };
        assert!(why.contains("set"), "{why}");
        assert!(to.join(NOT_MOVED).exists() && from.exists());
    }

    /// A FIFO (or socket) can't be copied: opening one to read would wait for a writer.
    #[cfg(unix)]
    #[test]
    fn a_copy_refuses_what_isnt_a_file_a_folder_or_a_link() {
        let t = tempfile::tempdir().unwrap();
        let (from, to) = (t.path().join("gitbolt"), t.path().join("gitvolt"));
        write(&from.join("settings.json"), "old");
        nix::unistd::mkfifo(&from.join("pipe"), nix::sys::stat::Mode::S_IRWXU).unwrap();
        let folder = from.clone();
        let refuse = move |a: &Path, b: &Path| if a == folder { Err(std::io::Error::other("busy")) } else { std::fs::rename(a, b) };
        assert!(matches!(move_dir(&mv(&from, &to, &[]), &refuse), Outcome::Failed(_)));
        assert!(from.join("pipe").exists() && !to.exists());
        assert!(!t.path().join(".gitvolt.moving").exists());
    }

    #[test]
    fn the_check_finds_a_byte_that_differs_and_a_missing_file() {
        let t = tempfile::tempdir().unwrap();
        let (a, b) = (t.path().join("a"), t.path().join("b"));
        write(&a.join("x/f"), "same length A");
        write(&b.join("x/f"), "same length B");
        assert!(same_tree(&a, &b, &[]).is_err());
        write(&b.join("x/f"), "same length A");
        same_tree(&a, &b, &[]).unwrap();
        write(&a.join("missing"), "x");
        assert!(same_tree(&a, &b, &[]).is_err(), "a file the copy lacks");
    }

    #[test]
    fn shared_folders_move_once() {
        let mac = Bases { config: "/h/Library/Application Support".into(), data: "/h/Library/Application Support".into(), cache: "/h/Library/Caches".into(), profile: Some("/h/Library/Caches".into()) };
        let m = moves(&mac);
        assert_eq!(m.len(), 3, "config and data are one folder: {m:?}");
        assert_eq!(m[2], Move { from: PathBuf::from("/h/Library/Caches").join(legacy::IDENTIFIER), to: PathBuf::from("/h/Library/Caches").join(paths::IDENTIFIER), transient: vec![] });
        let win = Bases { config: "/r".into(), data: "/l".into(), cache: "/l".into(), profile: Some("/l".into()) };
        let got: Vec<(PathBuf, Vec<&str>)> = moves(&win).into_iter().map(|m| (m.from, m.transient)).collect();
        assert_eq!(got, vec![
            (PathBuf::from("/r").join(legacy::APP_DIR), vec![]),
            (PathBuf::from("/l").join(legacy::APP_DIR), vec!["updates"]),
            (PathBuf::from("/l").join(legacy::IDENTIFIER), vec![]),
        ], "data and cache are one folder: one move, without the download");
        assert_eq!(moves(&Bases { profile: None, ..win }).len(), 2, "a dev instance's profile is in its cache folder");
    }
}
