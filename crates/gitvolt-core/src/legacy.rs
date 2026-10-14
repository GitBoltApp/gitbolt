//! GitBolt, the app's name before 0.7.0: the names it left on disk, in the keyring and in
//! repositories, which GitVolt takes over (`migrate`, forge tokens, Compare, the rebase notes).
//! Nothing here is written anew: each old name is only read, renamed to GitVolt's, or removed.

use std::path::{Path, PathBuf};

/// The app's folder name in each base folder.
#[cfg(target_os = "macos")]
pub const APP_DIR: &str = "GitBolt";
#[cfg(not(target_os = "macos"))]
pub const APP_DIR: &str = "gitbolt";

/// The bundle identifier, which names Chromium's profile folder (`<user's cache>/<it>/cef`).
pub const IDENTIFIER: &str = "dev.gitbolt.desktop";

/// The macOS bundle's name: GitBolt 0.6.1's updater installs GitVolt.app beside it and removes it
/// only on Restart, so a quit instead leaves it there (`updates::install::leftover_legacy_bundle`).
pub const BUNDLE_NAME: &str = "GitBolt.app";

/// The log files' prefix (`gitbolt.YYYY-MM-DD.log`): moved with the cache, pruned with GitVolt's.
pub const LOG_PREFIX: &str = "gitbolt";

/// GitBolt's config folder (`~/.config/gitbolt`), which keyed its single-instance guard.
pub fn config_dir() -> PathBuf {
    crate::paths::config_base().join(APP_DIR)
}

/// The single-instance lock and socket's name (`gitbolt-instance-<key>.lock`, `.sock`).
pub const INSTANCE_NAME: &str = "gitbolt-instance";

/// Where GitBolt kept its lock: `$XDG_RUNTIME_DIR`, else its own folder in the temp dir
/// (`gitbolt-<user>`: macOS, Windows). Only a path: nothing is created.
pub fn runtime_dir() -> PathBuf {
    dirs::runtime_dir().unwrap_or_else(|| std::env::temp_dir().join(format!("gitbolt-{}", crate::platform::fs::user_tag())))
}

/// The keyring service of forge tokens (account `<profile id>/<host>`, as GitVolt's).
pub const KEYRING_SERVICE: &str = "gitbolt";

/// Where GitBolt's Compare kept the MR/PR heads it fetched: the next Compare removes them with
/// its own older ones (`netops`).
pub const COMPARE_REFS: &str = "refs/gitbolt/compare/";

/// The notes GitBolt's interactive rebase kept in git's `rebase-merge/`, with GitVolt's names.
pub(crate) const REBASE_NOTES: [(&str, &str); 6] = [
    ("rebase-merge/gitbolt-irebase", crate::in_progress::GITVOLT_MARKER),
    ("rebase-merge/gitbolt-message-applied", crate::in_progress::MESSAGE_APPLIED),
    ("rebase-merge/gitbolt-message-failed", crate::in_progress::MESSAGE_FAILED),
    ("rebase-merge/gitbolt-refused", crate::in_progress::REFUSED),
    ("rebase-merge/gitbolt-edit-staged", crate::in_progress::EDIT_STAGED),
    ("rebase-merge/gitbolt-stop-content", crate::in_progress::STOP_CONTENT),
];

/// A rebase GitBolt paused carries on as GitVolt's: each of its notes in `git_dir` takes
/// GitVolt's name, unless GitVolt's is already there.
pub(crate) fn adopt_rebase_notes(git_dir: &Path) {
    for (old, new) in REBASE_NOTES {
        let (old, new) = (git_dir.join(old), git_dir.join(new));
        if old.is_file() && !new.exists() {
            let _ = std::fs::rename(&old, &new);
        }
    }
}
