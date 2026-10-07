//! XDG locations (spec §14.3), through the `dirs` crate the app already uses for its caches:
//! relative XDG values are ignored, as the XDG spec requires. Without a home directory, the
//! temp dir stands in so callers always get a path. On Windows `dirs` gives the Known Folders:
//! config in `%APPDATA%` (roaming), cache and data in `%LOCALAPPDATA%` (this machine's: the
//! journal and temp index files name local paths).

use crate::platform::fs as pfs;
use std::path::{Path, PathBuf};

pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir().filter(|p| p.is_absolute())
}

/// `~/.config/gitbolt` (`%APPDATA%\gitbolt`)
pub fn config_dir() -> PathBuf {
    base_in(dev_dirs(), "config", dirs::config_dir).unwrap_or_else(std::env::temp_dir).join("gitbolt")
}

/// `~/.cache/gitbolt` (`%LOCALAPPDATA%\gitbolt`)
pub fn cache_dir() -> PathBuf {
    cache_base().unwrap_or_else(std::env::temp_dir).join("gitbolt")
}

/// The user's cache folder (`~/.cache`, `%LOCALAPPDATA%`), if there's one.
pub fn cache_base() -> Option<PathBuf> {
    base_in(dev_dirs(), "cache", dirs::cache_dir)
}

/// `~/.local/share/gitbolt` (`%LOCALAPPDATA%\gitbolt`; spec #2 §5.1): the undo journal and temp
/// index files. Only `gitbolt-app` points the `Api` here; the harness and tests use a temp dir.
pub fn data_dir() -> PathBuf {
    base_in(dev_dirs(), "data", dirs::data_local_dir).unwrap_or_else(std::env::temp_dir).join("gitbolt")
}

/// Debug builds only: `GITBOLT_DEV_DIRS=<absolute dir>` puts the config, cache and data folders
/// in `<dir>\config`, `<dir>\cache` and `<dir>\data`, for a throwaway instance. Windows' Known
/// Folders can't be pointed elsewhere from the environment the way `XDG_*` can on Linux.
/// Release builds never read it.
#[cfg(debug_assertions)]
pub const DEV_DIRS: &str = "GITBOLT_DEV_DIRS";

/// [`DEV_DIRS`]'s folder, when it's set to an absolute path (always none in a release build).
pub fn dev_dirs() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os(DEV_DIRS).map(PathBuf::from).filter(|p| p.is_absolute()) {
        return Some(dir);
    }
    None
}

fn base_in(dev_dirs: Option<PathBuf>, dev_name: &str, system: fn() -> Option<PathBuf>) -> Option<PathBuf> {
    dev_dirs.map(|dir| dir.join(dev_name)).or_else(system)
}

/// Where the askpass socket and the single-instance lock live: `$XDG_RUNTIME_DIR` (per-user,
/// 0700), else a private `gitbolt-<uid>` folder in the temp dir (see [`private_dir`]). Windows
/// has no runtime dir: `%TEMP%\gitbolt-<user>`, in the user's own temp dir.
pub fn runtime_dir() -> std::io::Result<PathBuf> {
    match dirs::runtime_dir() {
        Some(dir) => Ok(dir),
        None => private_dir(&std::env::temp_dir().join(format!("gitbolt-{}", pfs::user_tag()))),
    }
}

/// `path` as a folder only this user can use: created `0700` if it's missing; if it's there, it
/// must be a real folder (not a symlink someone planted in a shared temp dir) owned by this user,
/// and its mode is set back to `0700`. In a sticky temp dir nobody else can then swap it out.
/// (Windows: the folders GitBolt uses are in the user's profile, private by its ACL; see
/// [`crate::platform::fs`].)
pub(crate) fn private_dir(path: &Path) -> std::io::Result<PathBuf> {
    use std::io::{Error, ErrorKind};
    match pfs::private_dir_builder(&mut std::fs::DirBuilder::new()).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = std::fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(Error::other(format!("{} isn't a directory", path.display())));
    }
    if !pfs::owned_by_me(&meta) {
        return Err(Error::new(ErrorKind::PermissionDenied, format!("{} belongs to another user", path.display())));
    }
    if pfs::mode(&meta) & 0o777 != 0o700 {
        pfs::set_mode(path, 0o700)?;
    }
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `GITBOLT_DEV_DIRS` replaces each system folder with its own subfolder; unset, the system
    /// folder is used.
    #[test]
    fn dev_dirs_stand_in_for_the_system_folders() {
        let dev = std::env::temp_dir().join("gb-dev");
        let system = || Some(PathBuf::from("/system/config"));
        assert_eq!(base_in(Some(dev.clone()), "config", system), Some(dev.join("config")));
        assert_eq!(base_in(None, "config", system), Some(PathBuf::from("/system/config")));
        assert_eq!(base_in(None, "cache", || None), None);
    }

    #[test]
    fn locations_are_absolute_and_namespaced() {
        for dir in [super::config_dir(), super::cache_dir(), super::data_dir()] {
            assert!(dir.is_absolute(), "{}", dir.display());
            assert!(dir.ends_with("gitbolt"), "{}", dir.display());
        }
        assert!(super::runtime_dir().unwrap().is_absolute());
    }

    #[test]
    fn the_private_fallback_refuses_a_file_and_reuses_a_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(format!("gitbolt-{}", pfs::user_tag()));
        assert_eq!(private_dir(&dir).unwrap(), dir);
        assert!(dir.is_dir());
        assert_eq!(private_dir(&dir).unwrap(), dir, "an existing one of ours is reused");
        let file = tmp.path().join("file");
        std::fs::write(&file, "x").unwrap();
        assert!(private_dir(&file).is_err());
    }

    #[cfg(unix)]
    fn mode(p: &Path) -> u32 {
        pfs::mode(&std::fs::metadata(p).unwrap()) & 0o777
    }

    /// Unix only: Windows has no mode bits (the folder is private by its ACL).
    #[cfg(unix)]
    #[test]
    fn the_private_fallback_is_created_0700_and_its_mode_is_fixed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(format!("gitbolt-{}", pfs::user_tag()));
        assert_eq!(private_dir(&dir).unwrap(), dir);
        assert_eq!(mode(&dir), 0o700);
        pfs::set_mode(&dir, 0o755).unwrap();
        assert_eq!(private_dir(&dir).unwrap(), dir, "an existing one of ours is reused");
        assert_eq!(mode(&dir), 0o700, "and made private again");
    }

    /// Unix only: no owner check on Windows, and `/` is root's only on Unix.
    #[cfg(unix)]
    #[test]
    fn the_private_fallback_refuses_a_symlink_a_file_or_someone_elses_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        pfs::set_mode(&target, 0o755).unwrap();
        let link = tmp.path().join("link");
        pfs::symlink(target.as_os_str(), &link).unwrap();
        assert!(private_dir(&link).is_err(), "a planted symlink");
        assert_eq!(mode(&target), 0o755, "its target is left alone");
        let file = tmp.path().join("file");
        std::fs::write(&file, "x").unwrap();
        assert!(private_dir(&file).is_err());
        if !pfs::is_root() {
            assert_eq!(private_dir(Path::new("/")).unwrap_err().kind(), std::io::ErrorKind::PermissionDenied, "owned by root, not us");
        }
    }
}
