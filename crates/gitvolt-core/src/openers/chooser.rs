//! "Other…" (feedback H32): the system's Open With chooser for one file. On Linux it's
//! xdg-desktop-portal's `org.freedesktop.portal.OpenURI.OpenFile` with `ask: true`, which takes
//! the file as a read-only descriptor; without the portal, `xdg-open` (logged). On Windows it's
//! the shell's own Open With dialog (`win32.rs`). macOS plugs into `system_chooser` later
//! (spec §4).

use crate::error::GbError;
use std::path::Path;
use std::sync::Arc;

/// Opens the chooser for an absolute file path the API has checked.
pub type Chooser = Arc<dyn Fn(&Path) -> Result<(), GbError> + Send + Sync>;

/// How a portal call (a connect, or the request itself) didn't produce a result.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PortalError {
    /// It answered, but with an error (no session bus, no such service, …): the portal itself
    /// isn't usable right now, so a fallback is safe.
    Failed(String),
    /// The bus connection itself is gone (broken pipe, reset, not connected, …). Classified from
    /// the underlying I/O error's *kind* (`linux::classify_zbus_error`), not by matching the
    /// error's message text (fix round 1, item 6: a stringly-typed `is_disconnect` heuristic could
    /// miss a real disconnect, or match an unrelated message that happens to contain the same
    /// words). Handled the same as `Failed` by `open_with` (a fallback is safe), but also tells
    /// `forget_on_disconnect` to drop the cached connection.
    Disconnected(String),
    /// It didn't answer within the timeout. The request may still be pending — a slow portal can
    /// still pop its dialog after this returns — so falling back here risks a second, competing
    /// open of the same file (deferred Rust minor #3). The caller logs and gives up instead.
    TimedOut,
}

impl std::fmt::Display for PortalError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            PortalError::Failed(why) | PortalError::Disconnected(why) => write!(f, "{why}"),
            PortalError::TimedOut => write!(f, "it didn't answer in time"),
        }
    }
}

/// Asks `portal` to show the chooser for `file`. A definite failure (no portal, no session bus, or
/// the connection dropping out) logs why and runs `fallback` instead; a timeout logs and does
/// nothing further, since the portal may still open its dialog on its own (minor #3: falling back
/// here risked a double open).
pub fn open_with(file: &Path, portal: impl FnOnce(&Path) -> Result<(), PortalError>, fallback: impl FnOnce(&Path) -> Result<(), GbError>) -> Result<(), GbError> {
    match portal(file) {
        Ok(()) => Ok(()),
        Err(PortalError::TimedOut) => {
            tracing::warn!("the Open With portal for {} didn't answer in time; not falling back, in case it still opens its own dialog", file.display());
            Ok(())
        }
        Err(PortalError::Failed(why)) | Err(PortalError::Disconnected(why)) => {
            tracing::warn!("the Open With portal isn't available ({why}); opening {} with xdg-open instead", file.display());
            fallback(file)
        }
    }
}

/// The value in `slot`, connecting (or reusing an existing connection) within `timeout`. Minor
/// #2: connecting used to run outside any timeout while holding this lock, so a hung session bus
/// wedged every later "Other…" behind it; now the connect itself is timed, and the lock is held
/// only to read or store the result, never while connecting.
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn shared<T: Clone + Send + 'static>(slot: &std::sync::Mutex<Option<T>>, make: impl FnOnce() -> Result<T, PortalError> + Send + 'static, timeout: std::time::Duration) -> Result<T, PortalError> {
    {
        let held = slot.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(v) = held.as_ref() {
            return Ok(v.clone());
        }
    }
    let v = with_timeout(make, timeout)?;
    let mut held = slot.lock().unwrap_or_else(|p| p.into_inner());
    // Fix round 1, item 5: another caller may have connected and stored its own value first,
    // while we were still connecting outside the lock. Use that one instead of overwriting it
    // with ours, so every caller ends up sharing exactly one connection (ours is simply dropped).
    if let Some(existing) = held.as_ref() {
        return Ok(existing.clone());
    }
    *held = Some(v.clone());
    Ok(v)
}

/// A connect that times out never reached the portal at all — no dialog could possibly be in
/// flight — so, unlike a timed-out call (`open_with`'s minor #3 rule), it's safe, and more useful,
/// to treat it as an ordinary failure: the caller falls back to `xdg-open` instead of silently
/// doing nothing (fix round 1, item 3).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn connect_timeout_is_a_failure<T>(r: Result<T, PortalError>) -> Result<T, PortalError> {
    r.map_err(|e| match e {
        PortalError::TimedOut => PortalError::Failed("the session bus didn't answer in time".into()),
        other => other,
    })
}

/// Drops a cached connection once a call on it reports the connection itself is gone, so the next
/// call reconnects instead of reusing a dead one forever (minor #2's second half: a connection
/// that outlives the bus session, e.g. after a logout/login, used to be kept and fail every time).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn forget_on_disconnect<T>(slot: &std::sync::Mutex<Option<T>>, why: &PortalError) {
    if matches!(why, PortalError::Disconnected(_)) {
        *slot.lock().unwrap_or_else(|p| p.into_inner()) = None;
    }
}

/// Runs `call` on its own thread and waits at most `timeout` for it. A call that doesn't answer
/// is left to finish (or fail) on its own: Rust has no way to cancel a blocking call, so the
/// thread is simply abandoned rather than joined — `tx.send` then fails silently once `rx` is
/// dropped. That costs one thread and whatever `call` captured (here, a cheap `Connection` clone)
/// for as long as `call` takes to return on its own, which for a truly wedged bus could be the
/// life of the process; nothing else waits on or retains that thread.
/// `PortalError::TimedOut` tells the caller not to treat a timeout the same as a definite failure
/// (see `open_with`).
#[cfg_attr(not(target_os = "linux"), allow(dead_code))]
pub(crate) fn with_timeout<T: Send + 'static>(call: impl FnOnce() -> Result<T, PortalError> + Send + 'static, timeout: std::time::Duration) -> Result<T, PortalError> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(call());
    });
    rx.recv_timeout(timeout).unwrap_or(Err(PortalError::TimedOut))
}

/// This OS's chooser, or `None` where there's none yet. `hook` adjusts the fallback's
/// environment, as for every launch (`ChildEnvHook`).
pub fn system_chooser(hook: super::ChildEnvHook) -> Option<Chooser> {
    #[cfg(target_os = "linux")]
    return Some(Arc::new(move |f: &Path| open_with(f, linux::portal_open_file, |f| linux::xdg_open(f, &*hook))));
    // The shell starts the chosen program, so `hook` has no command to adjust.
    #[cfg(windows)]
    {
        let _ = hook;
        Some(Arc::new(super::win32::open_with_dialog))
    }
    #[cfg(not(any(target_os = "linux", windows)))]
    {
        let _ = hook;
        None
    }
}

#[cfg(target_os = "linux")]
pub(crate) mod linux {
    use super::super::{find_in_path, spawn_detached_with, LaunchCommand};
    use super::PortalError;
    use crate::error::{GbError, GbErrorKind};
    use std::collections::HashMap;
    use std::path::{Path, PathBuf};
    use zbus::zvariant::{Fd, Value};

    /// The session bus, connected once and kept for the process lifetime: xdg-desktop-portal
    /// cancels a caller's pending requests (the open chooser dialog) when its connection goes
    /// away (fix round 2). Shared with `folder_picker`: both are xdg-desktop-portal interfaces on
    /// the same bus, so there's no reason to hold two connections.
    static BUS: std::sync::Mutex<Option<zbus::blocking::Connection>> = std::sync::Mutex::new(None);

    /// How long a connect or a call may take to answer (not a dialog the user is looking at:
    /// that's the user's time, and isn't awaited here at all).
    pub(crate) const CALL_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

    /// The shared session-bus connection, connecting within `CALL_TIMEOUT` if there isn't one
    /// cached yet (minor #2). Used by every portal interface in `openers/` (the Open With chooser
    /// here, the folder picker), so a hung bus blocks at most one such connect, not each caller
    /// separately, and a later disconnect is dropped from the cache by whoever notices it
    /// (`super::forget_on_disconnect`) rather than kept forever. A connect timeout is treated as
    /// an ordinary failure (fix round 1, item 3), not `PortalError::TimedOut`: no request has been
    /// made yet, so there's no in-flight dialog a fallback could race.
    pub(crate) fn shared_bus() -> Result<zbus::blocking::Connection, PortalError> {
        super::connect_timeout_is_a_failure(super::shared(&BUS, || zbus::blocking::Connection::session().map_err(classify_zbus_error), CALL_TIMEOUT))
    }

    pub(crate) fn forget_bus_on_disconnect(why: &PortalError) {
        super::forget_on_disconnect(&BUS, why);
    }

    /// Classifies a `zbus::Error` by its underlying I/O error *kind* (fix round 1, item 6), not by
    /// matching its message text: `Disconnected` for the kinds a severed connection actually
    /// produces, `Failed` for everything else (a missing service, a malformed call, …).
    pub(crate) fn classify_zbus_error(e: zbus::Error) -> PortalError {
        use std::io::ErrorKind::{BrokenPipe, ConnectionAborted, ConnectionReset, NotConnected, UnexpectedEof};
        let io_kind = match &e {
            zbus::Error::InputOutput(io) => Some(io.kind()),
            zbus::Error::Connection(io, _) => Some(io.kind()),
            _ => None,
        };
        if matches!(io_kind, Some(BrokenPipe | ConnectionReset | ConnectionAborted | NotConnected | UnexpectedEof)) {
            PortalError::Disconnected(e.to_string())
        } else {
            PortalError::Failed(e.to_string())
        }
    }

    /// `org.freedesktop.portal.OpenURI.OpenFile("", fd, {ask: true, writable: false})`: the portal
    /// shows its app chooser and opens the file (passed as a read-only descriptor, so it works
    /// from a sandbox too) in the app picked. The request's outcome isn't awaited, but the
    /// connection that made it stays open, so the dialog isn't cancelled.
    pub(super) fn portal_open_file(file: &Path) -> Result<(), PortalError> {
        let f = std::fs::File::open(file).map_err(|e| PortalError::Failed(e.to_string()))?;
        let bus = shared_bus()?;
        let result = super::with_timeout(
            move || {
                let options: HashMap<&str, Value<'_>> = HashMap::from([("ask", Value::from(true)), ("writable", Value::from(false))]);
                bus.call_method(Some("org.freedesktop.portal.Desktop"), "/org/freedesktop/portal/desktop", Some("org.freedesktop.portal.OpenURI"), "OpenFile", &("", Fd::from(&f), options))
                    .map(|_| ())
                    .map_err(classify_zbus_error)
            },
            CALL_TIMEOUT,
        );
        if let Err(why) = &result {
            forget_bus_on_disconnect(why);
        }
        result
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
    use std::sync::atomic::{AtomicI32, Ordering};
    use std::sync::Arc;

    /// Fix round 2: the portal cancels a caller's requests when its bus connection goes away,
    /// so the connection is made once and kept for the process lifetime. Minor #2: a failed
    /// connect is retried, never cached.
    #[test]
    fn the_bus_connection_is_made_once_and_kept_and_a_failed_one_is_retried() {
        let slot = std::sync::Mutex::new(None);
        let made = Arc::new(AtomicI32::new(0));
        let make = |succeed: bool| {
            let made = made.clone();
            move || {
                let n = made.fetch_add(1, Ordering::SeqCst) + 1;
                if succeed { Ok(n) } else { Err(PortalError::Failed("no session bus".to_string())) }
            }
        };
        let timeout = std::time::Duration::from_secs(1);
        assert_eq!(shared(&slot, make(false), timeout), Err(PortalError::Failed("no session bus".into())));
        assert_eq!(shared(&slot, make(true), timeout), Ok(2));
        assert_eq!(shared(&slot, make(true), timeout), Ok(2), "kept: make() isn't called a third time");
        assert_eq!(made.load(Ordering::SeqCst), 2);
    }

    /// Fix round 1, item 5: two callers finding the slot empty both connect outside the lock; the
    /// one that stores first must win, and the other's freshly-made value is simply dropped rather
    /// than overwriting it. Simulated (without real threads) by having `make` itself populate the
    /// slot as a side effect, standing in for "another thread finished connecting first".
    #[test]
    fn a_value_stored_while_connecting_wins_over_a_freshly_made_one() {
        static SLOT: std::sync::Mutex<Option<i32>> = std::sync::Mutex::new(None);
        let make = || {
            *SLOT.lock().unwrap() = Some(99);
            Ok(1)
        };
        assert_eq!(shared(&SLOT, make, std::time::Duration::from_secs(1)), Ok(99), "the value stored while we were connecting wins");
        assert_eq!(*SLOT.lock().unwrap(), Some(99), "our own freshly-made value (1) must not overwrite it");
    }

    /// Minor #2: the cache is dropped once a call reports the connection is gone, so the very
    /// next use reconnects instead of failing forever on a dead handle. Fix round 1, item 6: this
    /// now keys off the typed `Disconnected` variant, not a message-text heuristic.
    #[test]
    fn a_disconnected_error_drops_the_cached_value_but_an_ordinary_failure_does_not() {
        let slot = std::sync::Mutex::new(Some(7));
        forget_on_disconnect(&slot, &PortalError::Disconnected("broken pipe".into()));
        assert_eq!(*slot.lock().unwrap(), None);
        let slot = std::sync::Mutex::new(Some(7));
        forget_on_disconnect(&slot, &PortalError::Failed("permission denied".into()));
        assert_eq!(*slot.lock().unwrap(), Some(7), "an ordinary failure keeps the connection");
        let slot = std::sync::Mutex::new(Some(7));
        forget_on_disconnect(&slot, &PortalError::TimedOut);
        assert_eq!(*slot.lock().unwrap(), Some(7), "a timeout isn't a disconnect: the connection may still be fine");
    }

    /// Fix round 1, item 3: a connect timeout has no in-flight request to race, so it's treated as
    /// an ordinary failure (the caller falls back), never as `TimedOut` (which would do nothing).
    #[test]
    fn a_connect_timeout_becomes_an_ordinary_failure() {
        assert!(matches!(connect_timeout_is_a_failure::<i32>(Err(PortalError::TimedOut)), Err(PortalError::Failed(_))));
        assert_eq!(connect_timeout_is_a_failure(Ok(5)), Ok(5));
        assert_eq!(connect_timeout_is_a_failure::<i32>(Err(PortalError::Failed("x".into()))), Err(PortalError::Failed("x".into())));
        assert_eq!(connect_timeout_is_a_failure::<i32>(Err(PortalError::Disconnected("x".into()))), Err(PortalError::Disconnected("x".into())), "not a connect timeout: passed through unchanged");
    }

    #[test]
    fn a_portal_call_that_doesnt_answer_in_time_is_given_up() {
        assert_eq!(with_timeout(|| Ok(()), std::time::Duration::from_secs(5)), Ok(()));
        assert_eq!(with_timeout(|| Err::<(), _>(PortalError::Failed("denied".into())), std::time::Duration::from_secs(5)), Err(PortalError::Failed("denied".into())));
        let slow = with_timeout(
            || {
                std::thread::sleep(std::time::Duration::from_millis(500));
                Ok(())
            },
            std::time::Duration::from_millis(20),
        );
        assert_eq!(slow, Err(PortalError::TimedOut));
    }

    /// Fix round 1, item 6: classification goes by the I/O error's kind, not its message text.
    #[cfg(target_os = "linux")]
    #[test]
    fn classify_zbus_error_keys_off_the_io_error_kind() {
        use linux::classify_zbus_error;
        let broken = zbus::Error::InputOutput(std::sync::Arc::new(std::io::Error::new(std::io::ErrorKind::BrokenPipe, "x")));
        assert!(matches!(classify_zbus_error(broken), PortalError::Disconnected(_)));
        let reset = zbus::Error::InputOutput(std::sync::Arc::new(std::io::Error::new(std::io::ErrorKind::ConnectionReset, "x")));
        assert!(matches!(classify_zbus_error(reset), PortalError::Disconnected(_)));
        let denied = zbus::Error::InputOutput(std::sync::Arc::new(std::io::Error::new(std::io::ErrorKind::PermissionDenied, "x")));
        assert!(matches!(classify_zbus_error(denied), PortalError::Failed(_)), "an unrelated I/O error kind isn't a disconnect");
        assert!(matches!(classify_zbus_error(zbus::Error::InterfaceNotFound), PortalError::Failed(_)));
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
        open_with(Path::new("/w/a.php"), |_| Err(PortalError::Failed("org.freedesktop.DBus.Error.ServiceUnknown".into())), |f| { *fell_back.borrow_mut() = Some(f.to_path_buf()); Ok(()) }).unwrap();
        assert_eq!(fell_back.into_inner().as_deref(), Some(Path::new("/w/a.php")));
        let err = open_with(Path::new("/w/a.php"), |_| Err(PortalError::Failed("no bus".into())), |_| Err(GbError::new(GbErrorKind::NotFound, "no xdg-open"))).unwrap_err();
        assert_eq!(err.kind, GbErrorKind::NotFound);
    }

    /// A disconnected bus is handled exactly like an ordinary failure: a fallback is safe either
    /// way, since the connection (not just this one call) is gone.
    #[test]
    fn a_disconnected_bus_also_falls_back() {
        let fell_back = RefCell::new(false);
        open_with(Path::new("/w/a.php"), |_| Err(PortalError::Disconnected("broken pipe".into())), |_| { *fell_back.borrow_mut() = true; Ok(()) }).unwrap();
        assert!(fell_back.into_inner());
    }

    /// Minor #3: a portal that's still thinking (it may pop its dialog any moment) must not also
    /// get xdg-open running on the same file.
    #[test]
    fn a_timed_out_portal_call_never_falls_back() {
        let fell_back = RefCell::new(false);
        open_with(Path::new("/w/a.php"), |_| Err(PortalError::TimedOut), |_| { *fell_back.borrow_mut() = true; Ok(()) }).unwrap();
        assert!(!fell_back.into_inner(), "a timeout must not trigger the xdg-open fallback");
    }
}
