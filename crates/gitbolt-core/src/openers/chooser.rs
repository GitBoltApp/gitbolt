//! "Other…" (feedback H32): the system's Open With chooser for one file. On Linux it's
//! xdg-desktop-portal's `org.freedesktop.portal.OpenURI.OpenFile` with `ask: true`, which takes
//! the file as a read-only descriptor; without the portal, `xdg-open` (logged). Other OSes plug
//! into `system_chooser` later (spec §4).

use crate::error::GbError;
use std::path::Path;
use std::sync::Arc;

/// Opens the chooser for an absolute file path the API has checked.
pub type Chooser = Arc<dyn Fn(&Path) -> Result<(), GbError> + Send + Sync>;

/// Asks `portal` to show the chooser for `file`; when it can't (no portal, no session bus), logs
/// why and runs `fallback` instead.
pub fn open_with(file: &Path, portal: impl FnOnce(&Path) -> Result<(), String>, fallback: impl FnOnce(&Path) -> Result<(), GbError>) -> Result<(), GbError> {
    match portal(file) {
        Ok(()) => Ok(()),
        Err(why) => {
            tracing::warn!("the Open With portal isn't available ({why}); opening {} with xdg-open instead", file.display());
            fallback(file)
        }
    }
}

/// The value in `slot`, made by `make` the first time (and again after a failure): the portal's
/// session-bus connection, kept for the process lifetime.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn shared<T: Clone>(slot: &std::sync::Mutex<Option<T>>, make: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let mut held = slot.lock().unwrap_or_else(|p| p.into_inner());
    if let Some(v) = held.as_ref() {
        return Ok(v.clone());
    }
    let v = make()?;
    *held = Some(v.clone());
    Ok(v)
}

/// Runs `call` on its own thread and waits at most `timeout` for it. A call that doesn't answer
/// is left to finish (or fail) on its own; the caller falls back.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn with_timeout(call: impl FnOnce() -> Result<(), String> + Send + 'static, timeout: std::time::Duration) -> Result<(), String> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(call());
    });
    rx.recv_timeout(timeout).unwrap_or_else(|_| Err(format!("the portal didn't answer within {} s", timeout.as_secs_f32())))
}

/// This OS's chooser, or `None` where there's none yet. `hook` adjusts the fallback's
/// environment, as for every launch (`ChildEnvHook`).
pub fn system_chooser(hook: super::ChildEnvHook) -> Option<Chooser> {
    #[cfg(target_os = "linux")]
    return Some(Arc::new(move |f: &Path| open_with(f, linux::portal_open_file, |f| linux::xdg_open(f, &*hook))));
    #[cfg(not(target_os = "linux"))]
    {
        let _ = hook;
        None
    }
}

#[cfg(target_os = "linux")]
mod linux {
    use super::super::{find_in_path, spawn_detached_with, LaunchCommand};
    use crate::error::{GbError, GbErrorKind};
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use zbus::zvariant::{Fd, Value};

    /// The session bus, connected once and kept for the process lifetime: xdg-desktop-portal
    /// cancels a caller's pending requests (the open chooser dialog) when its connection goes
    /// away (fix round 2).
    static BUS: std::sync::Mutex<Option<zbus::blocking::Connection>> = std::sync::Mutex::new(None);

    /// How long `OpenFile` itself may take to answer (not the dialog: that's the user's time).
    const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    /// `org.freedesktop.portal.OpenURI.OpenFile("", fd, {ask: true, writable: false})`: the portal
    /// shows its app chooser and opens the file (passed as a read-only descriptor, so it works
    /// from a sandbox too) in the app picked. The request's outcome isn't awaited, but the
    /// connection that made it stays open, so the dialog isn't cancelled.
    pub(super) fn portal_open_file(file: &Path) -> Result<(), String> {
        let f = std::fs::File::open(file).map_err(|e| e.to_string())?;
        let bus = super::shared(&BUS, || zbus::blocking::Connection::session().map_err(|e| e.to_string()))?;
        super::with_timeout(
            move || {
                let options: HashMap<&str, Value<'_>> = HashMap::from([("ask", Value::from(true)), ("writable", Value::from(false))]);
                bus.call_method(Some("org.freedesktop.portal.Desktop"), "/org/freedesktop/portal/desktop", Some("org.freedesktop.portal.OpenURI"), "OpenFile", &("", Fd::from(&f), options))
                    .map(|_| ())
                    .map_err(|e| e.to_string())
            },
            CALL_TIMEOUT,
        )
    }

    /// `xdg-open <file>`: the default app, when the portal can't ask.
    pub(super) fn xdg_open(file: &Path, hook: &dyn Fn(&mut std::process::Command)) -> Result<(), GbError> {
        let path: Vec<PathBuf> = std::env::var_os("PATH").map(|p| std::env::split_paths(&p).filter(|d| d.is_absolute()).collect()).unwrap_or_default();
        let program = find_in_path(&path, "xdg-open").ok_or_else(|| GbError::new(GbErrorKind::NotFound, "neither the Open With portal nor xdg-open is available"))?;
        spawn_detached_with(&LaunchCommand { program, args: vec![file.into()] }, hook)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::error::GbErrorKind;
    use std::cell::RefCell;

    /// Fix round 2: the portal cancels a caller's requests when its bus connection goes away,
    /// so the connection is made once and kept for the process lifetime.
    #[test]
    fn the_bus_connection_is_made_once_and_kept_and_a_failed_one_is_retried() {
        let slot = std::sync::Mutex::new(None);
        let made = std::cell::Cell::new(0);
        let make = || {
            made.set(made.get() + 1);
            if made.get() == 1 { Err("no session bus".to_string()) } else { Ok(made.get()) }
        };
        assert!(shared(&slot, make).is_err());
        assert_eq!(shared(&slot, make), Ok(2));
        assert_eq!(shared(&slot, make), Ok(2), "kept");
        assert_eq!(made.get(), 2);
    }

    #[test]
    fn a_portal_call_that_doesnt_answer_in_time_is_given_up() {
        assert_eq!(with_timeout(|| Ok(()), std::time::Duration::from_secs(5)), Ok(()));
        assert_eq!(with_timeout(|| Err("denied".into()), std::time::Duration::from_secs(5)), Err("denied".into()));
        let slow = with_timeout(
            || {
                std::thread::sleep(std::time::Duration::from_millis(500));
                Ok(())
            },
            std::time::Duration::from_millis(20),
        );
        assert!(slow.unwrap_err().contains("didn't answer"), "a timeout falls back");
    }

    #[test]
    fn the_portal_is_used_when_it_answers() {
        let fell_back = RefCell::new(false);
        let asked = RefCell::new(None);
        open_with(Path::new("/w/a.php"), |f| { *asked.borrow_mut() = Some(f.to_path_buf()); Ok(()) }, |_| { *fell_back.borrow_mut() = true; Ok(()) }).unwrap();
        assert_eq!(asked.into_inner().as_deref(), Some(Path::new("/w/a.php")));
        assert!(!fell_back.into_inner());
    }

    #[test]
    fn without_the_portal_it_falls_back_and_reports_the_fallbacks_failure() {
        let fell_back = RefCell::new(None);
        open_with(Path::new("/w/a.php"), |_| Err("org.freedesktop.DBus.Error.ServiceUnknown".into()), |f| { *fell_back.borrow_mut() = Some(f.to_path_buf()); Ok(()) }).unwrap();
        assert_eq!(fell_back.into_inner().as_deref(), Some(Path::new("/w/a.php")));
        let err = open_with(Path::new("/w/a.php"), |_| Err("no bus".into()), |_| Err(GbError::new(GbErrorKind::NotFound, "no xdg-open"))).unwrap_err();
        assert_eq!(err.kind, GbErrorKind::NotFound);
    }
}
