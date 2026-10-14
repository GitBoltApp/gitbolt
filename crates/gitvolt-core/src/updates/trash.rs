//! The macOS Trash, through `NSFileManager`: no Automation prompt (Finder isn't scripted), a
//! symlink is trashed itself rather than its target, and it returns at once.

use std::path::Path;

/// Moves `path` to the user's Trash (`trashItemAtURL:resultingItemURL:error:`). The error is
/// Foundation's own description.
#[cfg(target_os = "macos")]
pub fn trash(path: &Path) -> Result<(), String> {
    use objc2_foundation::{NSFileManager, NSString, NSURL};
    let path = path.to_str().ok_or("the path isn't text")?;
    // `isDirectory` given: the URL is built without looking at the path.
    let url = NSURL::fileURLWithPath_isDirectory(&NSString::from_str(path), true);
    NSFileManager::defaultManager().trashItemAtURL_resultingItemURL_error(&url, None).map_err(|e| e.localizedDescription().to_string())
}

#[cfg(not(target_os = "macos"))]
pub fn trash(_path: &Path) -> Result<(), String> {
    Err("there is no Trash here".into())
}
