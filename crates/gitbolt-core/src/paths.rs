//! XDG locations (spec §14.3), through the `dirs` crate the app already uses for its caches:
//! relative XDG values are ignored, as the XDG spec requires. Without a home directory, the
//! temp dir stands in so callers always get a path.

use std::path::{Path, PathBuf};

pub fn home_dir() -> Option<PathBuf> {
    dirs::home_dir().filter(|p| p.is_absolute())
}

/// `~/.config/gitbolt`
pub fn config_dir() -> PathBuf {
    dirs::config_dir().unwrap_or_else(std::env::temp_dir).join("gitbolt")
}

/// `~/.cache/gitbolt`
pub fn cache_dir() -> PathBuf {
    dirs::cache_dir().unwrap_or_else(std::env::temp_dir).join("gitbolt")
}

/// Where the askpass socket lives: `$XDG_RUNTIME_DIR` (per-user, 0700), else a private
/// `gitbolt-<uid>` folder in the temp dir (see [`private_dir`]).
pub fn runtime_dir() -> std::io::Result<PathBuf> {
    match dirs::runtime_dir() {
        Some(dir) => Ok(dir),
        None => private_dir(&std::env::temp_dir().join(format!("gitbolt-{}", nix::unistd::geteuid()))),
    }
}

/// `path` as a folder only this user can use: created `0700` if it's missing; if it's there, it
/// must be a real folder (not a symlink someone planted in a shared temp dir) owned by this user,
/// and its mode is set back to `0700`. In a sticky temp dir nobody else can then swap it out.
fn private_dir(path: &Path) -> std::io::Result<PathBuf> {
    use std::io::{Error, ErrorKind};
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
    match std::fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(e) if e.kind() == ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e),
    }
    let meta = std::fs::symlink_metadata(path)?;
    if meta.file_type().is_symlink() || !meta.is_dir() {
        return Err(Error::other(format!("{} isn't a folder", path.display())));
    }
    if meta.uid() != nix::unistd::geteuid().as_raw() {
        return Err(Error::new(ErrorKind::PermissionDenied, format!("{} belongs to another user", path.display())));
    }
    if meta.mode() & 0o777 != 0o700 {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(path.to_path_buf())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn locations_are_absolute_and_namespaced() {
        for dir in [super::config_dir(), super::cache_dir()] {
            assert!(dir.is_absolute(), "{}", dir.display());
            assert!(dir.ends_with("gitbolt"), "{}", dir.display());
        }
        assert!(super::runtime_dir().unwrap().is_absolute());
    }

    fn mode(p: &Path) -> u32 {
        std::fs::metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn the_private_fallback_is_created_0700_and_its_mode_is_fixed() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join(format!("gitbolt-{}", nix::unistd::geteuid()));
        assert_eq!(private_dir(&dir).unwrap(), dir);
        assert_eq!(mode(&dir), 0o700);
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(private_dir(&dir).unwrap(), dir, "an existing one of ours is reused");
        assert_eq!(mode(&dir), 0o700, "and made private again");
    }

    #[test]
    fn the_private_fallback_refuses_a_symlink_a_file_or_someone_elses_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let target = tmp.path().join("elsewhere");
        std::fs::create_dir(&target).unwrap();
        std::fs::set_permissions(&target, std::fs::Permissions::from_mode(0o755)).unwrap();
        let link = tmp.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(private_dir(&link).is_err(), "a planted symlink");
        assert_eq!(mode(&target), 0o755, "its target is left alone");
        let file = tmp.path().join("file");
        std::fs::write(&file, "x").unwrap();
        assert!(private_dir(&file).is_err());
        if !nix::unistd::geteuid().is_root() {
            assert_eq!(private_dir(Path::new("/")).unwrap_err().kind(), std::io::ErrorKind::PermissionDenied, "owned by root, not us");
        }
    }
}
