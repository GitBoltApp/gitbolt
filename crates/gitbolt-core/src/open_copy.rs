//! "Open in…" for a file at an old commit (spec §14.5): that version is written to
//! `<cache>/<short sha>/<its path>` (the app's cache is `$XDG_CACHE_HOME/gitbolt/open`), read-only,
//! keeping its file name so the editor highlights it; copies older than a week are removed at
//! startup.

use crate::blob::{check_relative, safe_join};
use crate::error::{GbError, GbErrorKind};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// How long a copy is kept.
pub const MAX_AGE: Duration = Duration::from_secs(7 * 24 * 60 * 60);

/// Writes `bytes` as `<cache>/<key>/<rel>` (0444) and returns its path. `key` is a (short) hex
/// object id; `rel` is checked like a worktree path and joined with `safe_join` against the
/// copy's own root, so it can't land outside it. An existing copy is replaced.
pub fn write_copy(cache: &Path, key: &str, rel: &str, bytes: &[u8]) -> Result<PathBuf, GbError> {
    if key.is_empty() || key.len() > 64 || !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(GbError::new(GbErrorKind::InvalidInput, format!("not an object id: {key:?}")));
    }
    // The path is checked before any directory is made for it.
    check_relative(rel)?;
    let root = cache.join(key);
    // Neither the copy's root nor any existing folder under it may be a symlink: making the
    // folders would follow it and create directories wherever it points before `safe_join`
    // could refuse the path.
    let parts: Vec<&str> = rel.split('/').collect();
    let mut dir = root.clone();
    for (i, part) in std::iter::once("").chain(parts[..parts.len() - 1].iter().copied()).enumerate() {
        if i > 0 {
            dir.push(part);
        }
        if std::fs::symlink_metadata(&dir).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(GbError::new(GbErrorKind::InvalidInput, format!("path is outside the copy: {rel:?}")));
        }
    }
    // Private folders (0700 on unix), including ones an earlier version left more open.
    make_private_dirs(cache, &root, &dir)?;
    let dest = safe_join(&root, rel)?;
    // An earlier copy is read-only: replace it (the directory is ours and writable).
    match std::fs::symlink_metadata(&dest) {
        Ok(m) if m.is_dir() => return Err(GbError::new(GbErrorKind::InvalidInput, format!("{rel} is a directory in the copy"))),
        Ok(_) => std::fs::remove_file(&dest)?,
        Err(_) => {}
    }
    write_read_only(&dest, bytes)?;
    // The copy's root dates the copy for `clean` (a nested file doesn't touch its mtime).
    let _ = std::fs::File::open(&root).and_then(|d| d.set_modified(std::time::SystemTime::now()));
    Ok(dest)
}

/// Creates `cache`, then `root` and every folder down to `dir`, private to the user.
#[cfg(unix)]
fn make_private_dirs(cache: &Path, root: &Path, dir: &Path) -> Result<(), GbError> {
    use std::os::unix::fs::{DirBuilderExt, PermissionsExt};
    std::fs::DirBuilder::new().recursive(true).mode(0o700).create(dir)?;
    // Folders that already existed keep their mode: tighten the cache and this copy's.
    let private = std::fs::Permissions::from_mode(0o700);
    std::fs::set_permissions(cache, private.clone())?;
    let mut d = dir.to_path_buf();
    while d.starts_with(root) {
        std::fs::set_permissions(&d, private.clone())?;
        if !d.pop() {
            break;
        }
    }
    Ok(())
}

#[cfg(not(unix))]
fn make_private_dirs(_cache: &Path, _root: &Path, dir: &Path) -> Result<(), GbError> {
    std::fs::create_dir_all(dir)?;
    Ok(())
}

/// Writes a new file that is read-only from the moment it exists (0444 on unix, the read-only
/// attribute elsewhere): no window in which another process could open it for writing.
#[cfg(unix)]
fn write_read_only(dest: &Path, bytes: &[u8]) -> Result<(), GbError> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::OpenOptions::new().create_new(true).write(true).mode(0o444).open(dest)?.write_all(bytes)?;
    Ok(())
}

#[cfg(not(unix))]
fn write_read_only(dest: &Path, bytes: &[u8]) -> Result<(), GbError> {
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().create_new(true).write(true).open(dest)?;
    f.write_all(bytes)?;
    let mut perms = f.metadata()?.permissions();
    perms.set_readonly(true);
    std::fs::set_permissions(dest, perms)?;
    Ok(())
}

/// Removes the copies (each `<cache>/<key>` directory) last written more than `max_age` ago.
/// Returns how many went. Errors are ignored: it's housekeeping.
pub fn clean(cache: &Path, max_age: Duration) -> usize {
    let Ok(rd) = std::fs::read_dir(cache) else { return 0 };
    let now = std::time::SystemTime::now();
    let mut removed = 0;
    for e in rd.flatten() {
        let old = e.metadata().ok().filter(|m| m.is_dir()).and_then(|m| m.modified().ok()).and_then(|t| now.duration_since(t).ok()).is_some_and(|age| age > max_age);
        if old && std::fs::remove_dir_all(e.path()).is_ok() {
            removed += 1;
        }
    }
    removed
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::SystemTime;

    fn mode(p: &Path) -> u32 {
        std::fs::symlink_metadata(p).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_copy_keeps_its_path_and_bytes_and_is_read_only() {
        let tmp = tempfile::tempdir().unwrap();
        let p = write_copy(tmp.path(), "0123456789ab", "src/deep/app.php", b"<?php\n").unwrap();
        assert_eq!(p, tmp.path().canonicalize().unwrap().join("0123456789ab/src/deep/app.php"));
        // Fix round 2: every folder of a copy is private to the user.
        for dir in ["0123456789ab", "0123456789ab/src", "0123456789ab/src/deep"] {
            assert_eq!(mode(&tmp.path().join(dir)), 0o700, "{dir}");
        }
        assert_eq!(std::fs::read(&p).unwrap(), b"<?php\n");
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o444);
        // Written again (another open): replaced, still read-only.
        let again = write_copy(tmp.path(), "0123456789ab", "src/deep/app.php", b"<?php // v2\n").unwrap();
        assert_eq!(again, p);
        assert_eq!(std::fs::read(&p).unwrap(), b"<?php // v2\n");
        assert_eq!(std::fs::metadata(&p).unwrap().permissions().mode() & 0o777, 0o444);
    }

    #[test]
    fn the_cache_folder_is_made_private_even_when_it_already_existed() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("gitbolt/open");
        std::fs::create_dir_all(cache.join("abcdef/src")).unwrap();
        for d in [cache.clone(), cache.join("abcdef"), cache.join("abcdef/src")] {
            std::fs::set_permissions(&d, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        write_copy(&cache, "abcdef", "src/a.txt", b"a").unwrap();
        for d in [cache.clone(), cache.join("abcdef"), cache.join("abcdef/src")] {
            assert_eq!(mode(&d), 0o700, "{}", d.display());
        }
        assert_eq!(mode(&cache.join("abcdef/src/a.txt")), 0o444);
    }

    #[test]
    fn a_path_or_key_that_would_escape_the_cache_is_refused_before_anything_is_written() {
        let tmp = tempfile::tempdir().unwrap();
        let cache = tmp.path().join("open");
        for rel in ["../x.txt", "a/../../x.txt", "/etc/passwd", ".git/config", "a//b", ""] {
            let err = write_copy(&cache, "abc123", rel, b"x").unwrap_err();
            assert_eq!(err.kind, GbErrorKind::InvalidInput, "{rel:?}");
        }
        for key in ["", "..", "../x", "zz", "abc/def"] {
            assert_eq!(write_copy(&cache, key, "a.txt", b"x").unwrap_err().kind, GbErrorKind::InvalidInput, "{key:?}");
        }
        // A symlinked directory inside a copy's root can't redirect the write out of it.
        let outside = tmp.path().join("outside");
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::create_dir_all(cache.join("abc123")).unwrap();
        std::os::unix::fs::symlink(&outside, cache.join("abc123/link")).unwrap();
        assert_eq!(write_copy(&cache, "abc123", "link/x.txt", b"x").unwrap_err().kind, GbErrorKind::InvalidInput);
        // Not even a directory is made through it.
        assert_eq!(write_copy(&cache, "abc123", "link/sub/x.txt", b"x").unwrap_err().kind, GbErrorKind::InvalidInput);
        // Nor through a copy's own root being a symlink.
        std::os::unix::fs::symlink(&outside, cache.join("fedcba")).unwrap();
        assert_eq!(write_copy(&cache, "fedcba", "x.txt", b"x").unwrap_err().kind, GbErrorKind::InvalidInput);
        assert_eq!(write_copy(&cache, "fedcba", "sub/x.txt", b"x").unwrap_err().kind, GbErrorKind::InvalidInput);
        assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);
        assert!(!tmp.path().join("x.txt").exists());
    }

    #[test]
    fn copies_older_than_the_max_age_are_cleaned() {
        let tmp = tempfile::tempdir().unwrap();
        write_copy(tmp.path(), "aaaaaa", "old/file.txt", b"old").unwrap();
        write_copy(tmp.path(), "bbbbbb", "new.txt", b"new").unwrap();
        let week_ago = SystemTime::now() - MAX_AGE - Duration::from_secs(60);
        std::fs::File::open(tmp.path().join("aaaaaa")).unwrap().set_modified(week_ago).unwrap();
        assert_eq!(clean(tmp.path(), MAX_AGE), 1);
        assert!(!tmp.path().join("aaaaaa").exists());
        assert!(tmp.path().join("bbbbbb/new.txt").exists());
        assert_eq!(clean(&tmp.path().join("missing"), MAX_AGE), 0, "no cache yet: nothing to do");
    }
}
