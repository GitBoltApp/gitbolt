//! Permission bits, private files and folders, file identity.
//!
//! Windows has no POSIX mode bits. There, [`mode`] reads `0o644` for a file (`0o444` when it's
//! read-only) and `0o755` for a folder (`0o555`), never executable: git keeps the executable bit
//! in the index there (`core.fileMode=false`, which `git init` sets on Windows), so what GitBolt
//! writes and compares stays what git expects. [`set_mode`] only maps the owner-write bit to the
//! read-only attribute. "Private" (`0600`/`0700`) is the default there: files under the user's
//! profile (`%APPDATA%`, `%LOCALAPPDATA%`, `%TEMP%`) inherit its user-only ACL.

use std::ffi::OsStr;
use std::fs::{DirBuilder, File, Metadata, OpenOptions};
use std::io;
use std::path::Path;

/// The permission bits, as `st_mode` has them on Unix (callers mask what they need); see the
/// module docs for Windows.
pub fn mode(meta: &Metadata) -> u32 {
    imp::mode(meta)
}

/// Sets `path`'s permission bits (`chmod`). On Windows only the owner-write bit counts: without
/// it the file is made read-only, with it writable.
pub fn set_mode(path: impl AsRef<Path>, mode: u32) -> io::Result<()> {
    imp::set_mode(path.as_ref(), mode)
}

/// Whether git would run `path` as a hook or program: a file with an executable bit on Unix; on
/// Windows (no such bit) git for Windows' own test, a `.exe` or a file starting with `#!`.
pub fn is_executable(path: &Path) -> bool {
    imp::is_executable(path)
}

/// A new file is created `0600` (Unix).
pub fn private_file(opts: &mut OpenOptions) -> &mut OpenOptions {
    imp::private_file(opts)
}

/// A temp file is created `0600` (Unix).
pub fn private_temp<'r, 'a, 'b>(builder: &'r mut tempfile::Builder<'a, 'b>) -> &'r mut tempfile::Builder<'a, 'b> {
    imp::private_temp(builder)
}

/// Opening doesn't follow a symlink at the path (Unix: `O_NOFOLLOW`, and `O_NONBLOCK` so a
/// planted FIFO can't block; Windows: the link itself is opened, not its target).
pub fn no_follow(opts: &mut OpenOptions) -> &mut OpenOptions {
    imp::no_follow(opts)
}

/// A new folder is created `0700` (Unix).
pub fn private_dir_builder(builder: &mut DirBuilder) -> &mut DirBuilder {
    imp::private_dir_builder(builder)
}

/// Whether this user owns the file. On Windows, `true`: ownership there is an ACL matter, and
/// the folders GitBolt uses are under the user's profile, which only they can open.
pub fn owned_by_me(meta: &Metadata) -> bool {
    imp::owned_by_me(meta)
}

/// A short tag for this user, to name a per-user folder in a temp dir: the effective uid on
/// Unix; the user name on Windows (whose `%TEMP%` is the user's own anyway).
pub fn user_tag() -> String {
    imp::user_tag()
}

/// Whether this process runs as root (Unix); never on Windows.
pub fn is_root() -> bool {
    imp::is_root()
}

/// `fsync` on a folder, so a rename in it is durable. On Windows a no-op: NTFS journals the
/// rename, and a folder can't be flushed through a handle there.
pub fn sync_dir(dir: &Path) -> io::Result<()> {
    imp::sync_dir(dir)
}

/// A symlink at `link` to `target` (the bytes git stores for a link). On Windows a file symlink,
/// which needs Developer Mode or an elevated process; without either it's an error.
pub fn symlink(target: &OsStr, link: &Path) -> io::Result<()> {
    imp::symlink(target, link)
}

/// Sets the mtime of a file or folder (Windows needs write-attributes access for it, and a
/// folder opens only with backup semantics).
pub fn set_modified(path: impl AsRef<Path>, time: std::time::SystemTime) -> io::Result<()> {
    imp::open_for_times(path.as_ref())?.set_modified(time)
}

/// An absolute path as git prints it, as this OS spells it: unchanged on Unix; on Windows git
/// writes `C:/x/y`, which becomes `C:\x\y` (the same path, in the form users and std expect).
pub fn from_git_path(path: &str) -> std::path::PathBuf {
    if cfg!(windows) { path.replace('/', "\\").into() } else { path.into() }
}

/// A path as git (and the `sh` it runs scripts with) reads it: unchanged on Unix; on Windows
/// with `/` separators (`C:/x/y`), as a `\` would be an escape in a shell command.
pub fn to_git_path(path: impl AsRef<Path>) -> String {
    let s = path.as_ref().display().to_string();
    if cfg!(windows) { s.replace('\\', "/") } else { s }
}

/// `std::fs::canonicalize`. On Windows without the `\\?\` prefix std puts on every canonical
/// path (git can't open `\\?\C:\…`, and a user shouldn't read it), unless the path needs it.
pub fn canonicalize(path: impl AsRef<Path>) -> io::Result<std::path::PathBuf> {
    #[cfg(windows)]
    return dunce::canonicalize(path);
    #[cfg(not(windows))]
    return std::fs::canonicalize(path);
}

/// A file's identity: device and inode on Unix, volume serial number and file index on Windows.
/// Two paths with the same id are the same file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct FileId {
    pub dev: u64,
    pub ino: u64,
}

impl FileId {
    /// The open file's identity.
    pub fn of(file: &File) -> io::Result<Self> {
        imp::file_id(file)
    }

    /// The identity of what `path` names (following a symlink).
    pub fn of_path(path: &Path) -> io::Result<Self> {
        imp::path_id(path)
    }
}

#[cfg(unix)]
mod imp {
    use super::FileId;
    use std::ffi::OsStr;
    use std::fs::{DirBuilder, File, Metadata, OpenOptions};
    use std::io;
    use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt};
    use std::path::Path;

    pub fn mode(meta: &Metadata) -> u32 {
        meta.permissions().mode()
    }

    pub fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
    }

    pub fn is_executable(path: &Path) -> bool {
        std::fs::metadata(path).is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }

    pub fn private_file(opts: &mut OpenOptions) -> &mut OpenOptions {
        opts.mode(0o600)
    }

    pub fn private_temp<'r, 'a, 'b>(builder: &'r mut tempfile::Builder<'a, 'b>) -> &'r mut tempfile::Builder<'a, 'b> {
        builder.permissions(std::fs::Permissions::from_mode(0o600))
    }

    pub fn no_follow(opts: &mut OpenOptions) -> &mut OpenOptions {
        opts.custom_flags((nix::fcntl::OFlag::O_NOFOLLOW | nix::fcntl::OFlag::O_NONBLOCK).bits())
    }

    pub fn private_dir_builder(builder: &mut DirBuilder) -> &mut DirBuilder {
        builder.mode(0o700)
    }

    pub fn owned_by_me(meta: &Metadata) -> bool {
        meta.uid() == nix::unistd::geteuid().as_raw()
    }

    pub fn user_tag() -> String {
        nix::unistd::geteuid().to_string()
    }

    pub fn is_root() -> bool {
        nix::unistd::geteuid().is_root()
    }

    pub fn sync_dir(dir: &Path) -> io::Result<()> {
        File::open(dir)?.sync_all()
    }

    pub fn open_for_times(path: &Path) -> io::Result<File> {
        File::open(path)
    }

    pub fn symlink(target: &OsStr, link: &Path) -> io::Result<()> {
        std::os::unix::fs::symlink(target, link)
    }

    fn id(m: &Metadata) -> FileId {
        FileId { dev: m.dev(), ino: m.ino() }
    }

    pub fn file_id(file: &File) -> io::Result<FileId> {
        file.metadata().map(|m| id(&m))
    }

    pub fn path_id(path: &Path) -> io::Result<FileId> {
        std::fs::metadata(path).map(|m| id(&m))
    }
}

#[cfg(windows)]
mod imp {
    use super::FileId;
    use std::ffi::OsStr;
    use std::fs::{DirBuilder, File, Metadata, OpenOptions};
    use std::io::{self, Read};
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use std::path::Path;
    use windows_sys::Win32::Storage::FileSystem::{GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS};

    pub fn mode(meta: &Metadata) -> u32 {
        let base = if meta.is_dir() { 0o755 } else { 0o644 };
        if meta.permissions().readonly() { base & !0o222 } else { base }
    }

    pub fn set_mode(path: &Path, mode: u32) -> io::Result<()> {
        let mut perms = std::fs::metadata(path)?.permissions();
        let readonly = mode & 0o200 == 0;
        if perms.readonly() != readonly {
            perms.set_readonly(readonly);
            std::fs::set_permissions(path, perms)?;
        }
        Ok(())
    }

    pub fn is_executable(path: &Path) -> bool {
        if !std::fs::metadata(path).is_ok_and(|m| m.is_file()) {
            return false;
        }
        if path.extension().is_some_and(|e| e.eq_ignore_ascii_case("exe")) {
            return true;
        }
        let mut start = [0u8; 2];
        File::open(path).and_then(|mut f| f.read_exact(&mut start)).is_ok() && &start == b"#!"
    }

    pub fn private_file(opts: &mut OpenOptions) -> &mut OpenOptions {
        opts
    }

    pub fn private_temp<'r, 'a, 'b>(builder: &'r mut tempfile::Builder<'a, 'b>) -> &'r mut tempfile::Builder<'a, 'b> {
        builder
    }

    pub fn no_follow(opts: &mut OpenOptions) -> &mut OpenOptions {
        opts.custom_flags(windows_sys::Win32::Storage::FileSystem::FILE_FLAG_OPEN_REPARSE_POINT)
    }

    pub fn private_dir_builder(builder: &mut DirBuilder) -> &mut DirBuilder {
        builder
    }

    pub fn owned_by_me(_meta: &Metadata) -> bool {
        true
    }

    pub fn user_tag() -> String {
        let name = std::env::var("USERNAME").unwrap_or_default();
        let safe: String = name.chars().filter(|c| c.is_alphanumeric() || matches!(c, '-' | '_' | '.')).collect();
        if safe.is_empty() { "user".into() } else { safe }
    }

    pub fn is_root() -> bool {
        false
    }

    pub fn sync_dir(_dir: &Path) -> io::Result<()> {
        Ok(())
    }

    pub fn open_for_times(path: &Path) -> io::Result<File> {
        use windows_sys::Win32::Storage::FileSystem::FILE_WRITE_ATTRIBUTES;
        OpenOptions::new().access_mode(FILE_WRITE_ATTRIBUTES).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(path)
    }

    pub fn symlink(target: &OsStr, link: &Path) -> io::Result<()> {
        std::os::windows::fs::symlink_file(target, link)
    }

    pub fn file_id(file: &File) -> io::Result<FileId> {
        let mut info: BY_HANDLE_FILE_INFORMATION = unsafe { std::mem::zeroed() };
        // SAFETY: a valid open handle and a properly sized out-struct.
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        Ok(FileId { dev: u64::from(info.dwVolumeSerialNumber), ino: (u64::from(info.nFileIndexHigh) << 32) | u64::from(info.nFileIndexLow) })
    }

    pub fn path_id(path: &Path) -> io::Result<FileId> {
        // No access rights needed to query; backup semantics so a folder opens too.
        let file = OpenOptions::new().access_mode(0).custom_flags(FILE_FLAG_BACKUP_SEMANTICS).open(path)?;
        file_id(&file)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_owner_write_bit_round_trips() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("f");
        std::fs::write(&f, "x").unwrap();
        set_mode(&f, 0o444).unwrap();
        assert_eq!(mode(&std::fs::metadata(&f).unwrap()) & 0o222, 0, "read-only");
        set_mode(&f, 0o644).unwrap();
        assert_eq!(mode(&std::fs::metadata(&f).unwrap()) & 0o777, 0o644);
    }

    #[test]
    fn a_file_and_its_open_handle_have_one_id_and_another_file_another() {
        let dir = tempfile::tempdir().unwrap();
        let (a, b) = (dir.path().join("a"), dir.path().join("b"));
        std::fs::write(&a, "a").unwrap();
        std::fs::write(&b, "b").unwrap();
        let open = File::open(&a).unwrap();
        assert_eq!(FileId::of(&open).unwrap(), FileId::of_path(&a).unwrap());
        assert_ne!(FileId::of_path(&a).unwrap(), FileId::of_path(&b).unwrap());
        // A rename keeps the identity; a new file at the old name gets another one.
        let before = FileId::of_path(&a).unwrap();
        drop(open);
        std::fs::rename(&a, dir.path().join("c")).unwrap();
        assert_eq!(FileId::of_path(&dir.path().join("c")).unwrap(), before);
        assert!(FileId::of_path(dir.path()).is_ok(), "a folder has one too");
    }

    #[test]
    fn a_script_with_a_shebang_or_an_executable_bit_is_executable() {
        let dir = tempfile::tempdir().unwrap();
        let hook = dir.path().join("pre-commit");
        std::fs::write(&hook, "#!/bin/sh\nexit 0\n").unwrap();
        #[cfg(unix)]
        {
            assert!(!is_executable(&hook), "no executable bit yet");
            set_mode(&hook, 0o755).unwrap();
        }
        assert!(is_executable(&hook));
        assert!(!is_executable(dir.path()), "a folder isn't");
        assert!(!is_executable(&dir.path().join("missing")));
    }
}
