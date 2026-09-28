//! The process-wide Linux desktop setup GitBolt needs before GTK starts: how the window is named
//! to the desktop (dock icon, H13) and how the input method hands keys to the embedded browser
//! (Ctrl+C, zoom and the other chords, H19/H2).

use std::ffi::OsString;
use std::process::Command;
use std::sync::OnceLock;

/// The X11 `WM_CLASS` instance name (GLib's program name). The desktop matches a window to its
/// `.desktop` entry by it: the `.deb`'s entry (Tauri's bundler writes `StartupWMClass=<binary
/// name>`) and `just install-desktop`'s both say `gitbolt`. GTK derives the class half
/// (`Gitbolt`) from it. Unset, GTK4 leaves `WM_CLASS` empty and GNOME can't match the window
/// to any app, so the dock shows no GitBolt icon.
pub const PROGRAM_NAME: &str = "gitbolt";
/// The human-readable application name (GLib's), for the desktop's window lists.
pub const APPLICATION_NAME: &str = "GitBolt";

/// Environment the browser process sets for itself before GTK loads its input method.
///
/// `IBUS_ENABLE_SYNC_MODE=1`: IBus's GTK4 module in its asynchronous mode answers "handled" to
/// every key it's shown and re-emits the ones its engine didn't want later, as a GDK event.
/// Chromium feeds the input method from its own X11 events, outside GTK's event loop, so a
/// re-emitted key never reaches it: in an editable field (Monaco's input) Ctrl+C, Ctrl+X,
/// Ctrl+V, Ctrl+A, Ctrl+= / Ctrl+- / Ctrl+0 and every other chord the engine passes on are
/// dropped before the page, or CEF's `on_pre_key_event`, sees them. This was suspected as the
/// cause of dropped keys (see the lane V2 report), but that theory didn't hold up: the real
/// cause was mutter's `WM_TAKE_FOCUS` stealing X focus into GDK's focus window, fixed in
/// `vendor/tauri-runtime-cef/src/platform/linux/focus.rs`. Sync mode adds per-keystroke IPC
/// latency and changes IME behaviour for users of real input methods, so it's left off by
/// default and is opt-in via `GITBOLT_IBUS_SYNC=1`, kept as a diagnostic knob should IBus's
/// async mode misbehave again with some engine, not as the fix itself.
///
/// `get` reads the process environment (a snapshot in tests).
pub fn input_method_env(get: impl Fn(&str) -> Option<OsString>) -> Vec<(&'static str, &'static str)> {
    if get(IBUS_SYNC_OPT_IN).is_some_and(|v| v == "1") {
        vec![(IBUS_SYNC, "1")]
    } else {
        vec![]
    }
}

const IBUS_SYNC: &str = "IBUS_ENABLE_SYNC_MODE";
const IBUS_SYNC_OPT_IN: &str = "GITBOLT_IBUS_SYNC";
/// Set for the app's own process by the CEF runtime (`x11`, its X11-hosted browser).
const GDK_BACKEND: &str = "GDK_BACKEND";

/// The session's own values, before the app changed them for itself, of the variables it
/// changes: [`input_method_env`]'s and the CEF runtime's `GDK_BACKEND=x11`. A child the app
/// starts (git, an editor, the file manager) gets these back ([`restore_child_env`]): the
/// app's input-method workaround and X11 backend are its own business.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EnvSnapshot {
    vars: Vec<(&'static str, Option<OsString>)>,
}

impl EnvSnapshot {
    pub fn capture(get: impl Fn(&str) -> Option<OsString>) -> Self {
        Self { vars: [IBUS_SYNC, GDK_BACKEND].into_iter().map(|k| (k, get(k))).collect() }
    }

    /// Each variable back to its original value, or removed if it had none.
    pub fn apply(&self, cmd: &mut Command) {
        for (key, value) in &self.vars {
            match value {
                Some(v) => cmd.env(key, v),
                None => cmd.env_remove(key),
            };
        }
    }
}

static ORIGINAL_ENV: OnceLock<EnvSnapshot> = OnceLock::new();

/// Gives `cmd` the session's own values of the variables the app changed for itself (see
/// [`EnvSnapshot`]). Every child process the app starts goes through this. A no-op before
/// [`init`] (nothing changed yet).
pub fn restore_child_env(cmd: &mut Command) {
    if let Some(original) = ORIGINAL_ENV.get() {
        original.apply(cmd);
    }
}

/// Captures the session's environment ([`EnvSnapshot`]), applies [`input_method_env`] and sets
/// the GLib names. Call first thing in `main`: before any thread starts (environment writes
/// aren't thread-safe) and before Tauri initializes GTK and the CEF runtime sets `GDK_BACKEND`.
#[cfg(target_os = "linux")]
pub fn init() {
    let get = |k: &str| std::env::var_os(k);
    ORIGINAL_ENV.get_or_init(|| EnvSnapshot::capture(get));
    for (key, value) in input_method_env(get) {
        // SAFETY: called at the top of `main`, before GitBolt or Tauri start any thread.
        unsafe { std::env::set_var(key, value) };
    }
    glib::set_prgname(Some(PROGRAM_NAME));
    glib::set_application_name(APPLICATION_NAME);
}

#[cfg(not(target_os = "linux"))]
pub fn init() {}

#[cfg(test)]
mod tests {
    use super::*;

    use std::ffi::{OsStr, OsString};

    fn env_of<'a>(vars: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |k| vars.iter().find(|(n, _)| *n == k).map(|(_, v)| OsString::from(v))
    }

    #[test]
    fn ibus_sync_mode_is_left_untouched_by_default() {
        for session in [&[][..], &[("IBUS_ENABLE_SYNC_MODE", "0")][..], &[("IBUS_ENABLE_SYNC_MODE", "2")][..]] {
            assert_eq!(input_method_env(env_of(session)), vec![], "{session:?}");
        }
    }

    #[test]
    fn gitbolt_ibus_sync_1_opts_in() {
        assert_eq!(input_method_env(env_of(&[("GITBOLT_IBUS_SYNC", "1")])), vec![("IBUS_ENABLE_SYNC_MODE", "1")]);
        // Any other value keeps the default (untouched).
        assert_eq!(input_method_env(env_of(&[("GITBOLT_IBUS_SYNC", "0")])), vec![]);
        assert_eq!(input_method_env(env_of(&[("GITBOLT_IBUS_SYNC", "2")])), vec![]);
    }

    /// The variables the app changes for itself go back to the session's values for a child
    /// process, or away if the session had none.
    #[test]
    fn a_child_gets_the_sessions_own_values_back() {
        let original = EnvSnapshot::capture(env_of(&[("GDK_BACKEND", "wayland")]));
        let mut cmd = std::process::Command::new("true");
        cmd.env("IBUS_ENABLE_SYNC_MODE", "1").env("GDK_BACKEND", "x11");
        original.apply(&mut cmd);
        let envs: Vec<(&OsStr, Option<&OsStr>)> = cmd.get_envs().collect();
        assert!(envs.contains(&(OsStr::new("GDK_BACKEND"), Some(OsStr::new("wayland")))), "{envs:?}");
        assert!(envs.contains(&(OsStr::new("IBUS_ENABLE_SYNC_MODE"), None)), "{envs:?}");

        let original = EnvSnapshot::capture(env_of(&[("IBUS_ENABLE_SYNC_MODE", "2")]));
        let mut cmd = std::process::Command::new("true");
        original.apply(&mut cmd);
        let envs: Vec<(&OsStr, Option<&OsStr>)> = cmd.get_envs().collect();
        assert!(envs.contains(&(OsStr::new("IBUS_ENABLE_SYNC_MODE"), Some(OsStr::new("2")))), "{envs:?}");
        assert!(envs.contains(&(OsStr::new("GDK_BACKEND"), None)), "{envs:?}");
    }

    #[test]
    fn the_program_name_is_the_binary_the_desktop_entries_name() {
        // Tauri's .deb entry says `StartupWMClass=<binary name>`; so does `just install-desktop`.
        assert_eq!(PROGRAM_NAME, env!("CARGO_BIN_NAME"));
        let justfile = include_str!("../../../justfile");
        assert!(justfile.contains("StartupWMClass=gitbolt"), "just install-desktop's entry");
    }

    /// Tauri's default window icon is the first PNG in `bundle.icon`: a large one, so the window
    /// icon (`_NET_WM_ICON`) is sharp in the dock and the Alt+Tab switcher, not a 32 px one.
    #[test]
    fn the_window_icon_is_a_large_one() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        let first = conf["bundle"]["icon"][0].as_str().unwrap();
        let png = std::fs::read(std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join(first)).unwrap();
        let width = u32::from_be_bytes(png[16..20].try_into().unwrap());
        assert!(width >= 256, "{first} is {width} px wide");
    }
}
