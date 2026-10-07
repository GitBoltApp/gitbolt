//! OS strings from git's bytes (paths, environment entries). On Unix the bytes are the name, as
//! they are (a path needn't be UTF-8). On Windows git speaks UTF-8, and names are UTF-16 there:
//! the bytes are decoded as UTF-8, lossily if they aren't (git for Windows never prints such a
//! path). The other way, `OsStr::as_encoded_bytes` is the bytes on Unix and UTF-8 on Windows for
//! any valid name, so callers use it directly.

use std::borrow::Cow;
use std::ffi::{OsStr, OsString};

/// `bytes` as an OS string.
pub fn from_bytes(bytes: &[u8]) -> Cow<'_, OsStr> {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStrExt;
        Cow::Borrowed(OsStr::from_bytes(bytes))
    }
    #[cfg(windows)]
    {
        match String::from_utf8_lossy(bytes) {
            Cow::Borrowed(s) => Cow::Borrowed(OsStr::new(s)),
            Cow::Owned(s) => Cow::Owned(s.into()),
        }
    }
}

/// [`from_bytes`], owned.
pub fn from_vec(bytes: Vec<u8>) -> OsString {
    #[cfg(unix)]
    {
        use std::os::unix::ffi::OsStringExt;
        OsString::from_vec(bytes)
    }
    #[cfg(windows)]
    {
        match String::from_utf8(bytes) {
            Ok(s) => s.into(),
            Err(e) => String::from_utf8_lossy(e.as_bytes()).into_owned().into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf8_names_round_trip() {
        let name = "dossier/été.txt";
        assert_eq!(from_bytes(name.as_bytes()), OsStr::new(name));
        assert_eq!(from_vec(name.as_bytes().to_vec()), OsString::from(name));
        assert_eq!(from_bytes(name.as_bytes()).as_encoded_bytes(), name.as_bytes());
    }

    #[cfg(unix)]
    #[test]
    fn non_utf8_bytes_are_kept_on_unix() {
        assert_eq!(from_bytes(b"a\xffb").as_encoded_bytes(), b"a\xffb");
    }
}
