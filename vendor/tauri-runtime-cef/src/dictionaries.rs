// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! GitBolt patch: spell-check dictionaries the application ships, installed where Chromium
//! looks for them.
//!
//! Chromium reads its Hunspell dictionaries (`<language>-<version>.bdic`) from `Dictionaries/`
//! in the user data directory, which for CEF is the root cache path, and downloads a missing one
//! from Google. An application that keeps Chromium off the network ships the file instead, and
//! [`install`] copies it there before `cef::initialize`: only when it is missing or its content
//! differs, so an unchanged dictionary is never rewritten.

use std::{
  fs, io,
  path::{Path, PathBuf},
};

/// The directory under the root cache path Chromium reads dictionaries from
/// (`chrome::DIR_APP_DICTIONARIES`).
pub(crate) const DIR: &str = "Dictionaries";

/// What [`install`] did with one dictionary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Installed {
  /// There was none: copied.
  Copied,
  /// There was one with other content: replaced.
  Replaced,
  /// The same file was already there: left alone.
  Unchanged,
}

/// Puts `source` into `dir` under its own file name, unless an identical file is already there.
/// `dir` is created if needed. The copy goes to a temporary file in `dir` first and is renamed
/// over the old one, so Chromium never reads a half-written dictionary.
pub(crate) fn install(source: &Path, dir: &Path) -> io::Result<Installed> {
  let name = source.file_name().ok_or_else(|| {
    io::Error::new(
      io::ErrorKind::InvalidInput,
      format!("{} has no file name", source.display()),
    )
  })?;
  let wanted = fs::read(source)?;
  let target = dir.join(name);
  let outcome = match fs::read(&target) {
    Ok(present) if present == wanted => return Ok(Installed::Unchanged),
    Ok(_) => Installed::Replaced,
    Err(e) if e.kind() == io::ErrorKind::NotFound => Installed::Copied,
    Err(e) => return Err(e),
  };
  fs::create_dir_all(dir)?;
  let partial = partial_path(&target);
  let written = fs::write(&partial, &wanted).and_then(|()| fs::rename(&partial, &target));
  if written.is_err() {
    let _ = fs::remove_file(&partial);
  }
  written.map(|()| outcome)
}

fn partial_path(target: &Path) -> PathBuf {
  let mut name = target.file_name().unwrap_or_default().to_os_string();
  name.push(".partial");
  target.with_file_name(name)
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::sync::atomic::{AtomicUsize, Ordering};

  /// A fresh directory under the system temp dir, removed when dropped.
  struct TempDir(PathBuf);

  impl TempDir {
    fn new() -> Self {
      static COUNTER: AtomicUsize = AtomicUsize::new(0);
      let dir = std::env::temp_dir().join(format!(
        "tauri-cef-dictionaries-{}-{}",
        std::process::id(),
        COUNTER.fetch_add(1, Ordering::SeqCst)
      ));
      let _ = fs::remove_dir_all(&dir);
      fs::create_dir_all(&dir).unwrap();
      Self(dir)
    }

    fn path(&self) -> &Path {
      &self.0
    }
  }

  impl Drop for TempDir {
    fn drop(&mut self) {
      let _ = fs::remove_dir_all(&self.0);
    }
  }

  fn bundled(dir: &Path, content: &[u8]) -> PathBuf {
    let path = dir.join("en-US-10-1.bdic");
    fs::create_dir_all(dir).unwrap();
    fs::write(&path, content).unwrap();
    path
  }

  #[test]
  fn a_missing_dictionary_is_copied_into_a_new_directory() {
    let tmp = TempDir::new();
    let source = bundled(&tmp.path().join("share"), b"BDic one");
    let dir = tmp.path().join("cef").join(DIR);
    assert_eq!(install(&source, &dir).unwrap(), Installed::Copied);
    assert_eq!(fs::read(dir.join("en-US-10-1.bdic")).unwrap(), b"BDic one");
    assert_eq!(
      fs::read_dir(&dir).unwrap().count(),
      1,
      "no partial file left behind"
    );
  }

  #[test]
  fn the_same_dictionary_is_left_alone() {
    let tmp = TempDir::new();
    let source = bundled(&tmp.path().join("share"), b"BDic one");
    let dir = tmp.path().join(DIR);
    let present = bundled(&dir, b"BDic one");
    // Read-only: a rewrite would fail, so `Unchanged` means it wasn't touched.
    let mut perms = fs::metadata(&present).unwrap().permissions();
    perms.set_readonly(true);
    fs::set_permissions(&present, perms).unwrap();
    let before = fs::metadata(&present).unwrap().modified().unwrap();
    assert_eq!(install(&source, &dir).unwrap(), Installed::Unchanged);
    assert_eq!(fs::metadata(&present).unwrap().modified().unwrap(), before);
  }

  #[test]
  fn a_different_dictionary_is_replaced() {
    let tmp = TempDir::new();
    let source = bundled(&tmp.path().join("share"), b"BDic two, a newer one");
    let dir = tmp.path().join(DIR);
    bundled(&dir, b"BDic one");
    assert_eq!(install(&source, &dir).unwrap(), Installed::Replaced);
    assert_eq!(
      fs::read(dir.join("en-US-10-1.bdic")).unwrap(),
      b"BDic two, a newer one"
    );
    assert_eq!(
      fs::read_dir(&dir).unwrap().count(),
      1,
      "no partial file left behind"
    );
  }

  #[test]
  fn a_missing_bundled_file_is_an_error_and_creates_nothing() {
    let tmp = TempDir::new();
    let dir = tmp.path().join(DIR);
    let err = install(&tmp.path().join("gone.bdic"), &dir).unwrap_err();
    assert_eq!(err.kind(), io::ErrorKind::NotFound);
    assert!(!dir.exists());
  }
}
