//! "Open Repository" and "your repos" (spec §13): the system folder picker. On Linux it's
//! xdg-desktop-portal's `org.freedesktop.portal.FileChooser.OpenFile{directory: true}`, over the
//! same session-bus connection the "Other…" chooser uses (`chooser::linux::shared_bus`). Unlike
//! `OpenURI.OpenFile`, this call's result matters (the folder the user picked), so the request has
//! to be followed through the portal's `Request`/`Response` round trip.

use super::chooser::PortalError;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Asks the folder-picker portal, starting in `start` when given. `None` means either the user
/// cancelled, or (R2's ruling) the portal isn't available at all: a portal-less desktop simply
/// has no picker, which the caller treats exactly like a cancel (falling back to a typed path).
pub fn pick_folder(start: Option<&Path>, portal: impl FnOnce(Option<&Path>) -> Result<Option<PathBuf>, PortalError>) -> Option<PathBuf> {
    match portal(start) {
        Ok(picked) => picked,
        Err(why) => {
            tracing::warn!("the folder-picker portal isn't available ({why}); no folder was picked");
            None
        }
    }
}

/// Picks one folder for the app to use.
pub type FolderPicker = Arc<dyn Fn(Option<&Path>) -> Option<PathBuf> + Send + Sync>;

/// This OS's folder picker, or `None` where there's none yet (spec §4). `parent_window` supplies
/// the portal's `parent_window` token (`x11:<xid>`, computed by the app from its own window) fresh
/// on every call, since the app's window may not exist yet the first time this is used.
pub fn system_folder_picker(parent_window: impl Fn() -> String + Send + Sync + 'static) -> Option<FolderPicker> {
    #[cfg(target_os = "linux")]
    return Some(Arc::new(move |start: Option<&Path>| pick_folder(start, |s| linux::portal_pick_folder(s, parent_window()))));
    #[cfg(not(target_os = "linux"))]
    {
        let _ = parent_window;
        None
    }
}

/// `file://…` (with `localhost` or no authority), percent-decoded. `None` for anything else the
/// portal could in principle return (it never has in practice, but a picker is user input).
fn uri_to_path(uri: &str) -> Option<PathBuf> {
    let rest = uri.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    rest.starts_with('/').then(|| PathBuf::from(percent_decode(rest)))
}

/// `%XX` escapes decoded to raw bytes (then read back as UTF-8, lossily: a real portal URI is
/// already valid UTF-8 percent-encoded, so this only matters for malformed input).
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let Ok(b) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16)
        {
            out.push(b);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[cfg(target_os = "linux")]
mod linux {
    use super::super::chooser::{linux as chooser_linux, with_timeout, PortalError};
    use super::uri_to_path;
    use std::collections::HashMap;
    use std::os::unix::ffi::OsStrExt;
    use std::path::{Path, PathBuf};
    use std::sync::atomic::{AtomicU64, Ordering};
    use zbus::zvariant::{OwnedObjectPath, OwnedValue, Value};

    /// Folder picking is interactive (the user browses), so this is nothing like the 5 s
    /// `OpenURI` call timeout: it bounds the whole round trip, dialog included, against a portal
    /// that never answers at all. Being ten minutes rather than five seconds makes `with_timeout`'s
    /// documented cost (an abandoned thread, still holding this `bus` clone, if `pick_once` never
    /// returns) worth restating here: a picker the user walked away from ties up one thread for up
    /// to that long, not just a handful of seconds.
    const PICKER_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10 * 60);

    fn unique_token() -> String {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        format!("gitbolt{}", NEXT.fetch_add(1, Ordering::Relaxed))
    }

    /// The `Request` object path the portal will use for a call made with this `handle_token`,
    /// computed ahead of the call so the `Response` signal can be subscribed to first — avoiding
    /// the race of calling `OpenFile` and only then listening (xdg-desktop-portal's documented
    /// pattern). A portal that doesn't honour `handle_token` (or mangles it on a collision) can
    /// still return a different path in `OpenFile`'s own reply; `pick_once` re-subscribes on that
    /// one when it happens (fix round 1, item 7).
    fn request_path(bus: &zbus::blocking::Connection, token: &str) -> Result<String, PortalError> {
        let unique = bus.unique_name().ok_or_else(|| PortalError::Failed("no unique bus name yet".into()))?;
        let sender = unique.trim_start_matches(':').replace('.', "_");
        Ok(format!("/org/freedesktop/portal/desktop/request/{sender}/{token}"))
    }

    /// Subscribes to the `Request.Response` signal on `path`, before any call that might trigger
    /// it is made.
    fn subscribe(bus: &zbus::blocking::Connection, path: &str) -> Result<zbus::blocking::MessageIterator, PortalError> {
        let rule = zbus::MatchRule::builder()
            .msg_type(zbus::message::Type::Signal)
            .interface("org.freedesktop.portal.Request")
            .and_then(|b| b.member("Response"))
            .and_then(|b| b.path(path))
            .map_err(|e| PortalError::Failed(e.to_string()))?
            .build();
        zbus::blocking::MessageIterator::for_match_rule(rule, bus, Some(1)).map_err(|e| PortalError::Failed(e.to_string()))
    }

    pub(super) fn portal_pick_folder(start: Option<&Path>, parent_window: String) -> Result<Option<PathBuf>, PortalError> {
        let bus = chooser_linux::shared_bus()?;
        let start_nul: Option<Vec<u8>> = start.map(|p| {
            let mut b = p.as_os_str().as_bytes().to_vec();
            b.push(0);
            b
        });
        let result = with_timeout(move || pick_once(&bus, &parent_window, start_nul.as_deref()), PICKER_TIMEOUT);
        if let Err(why) = &result {
            chooser_linux::forget_bus_on_disconnect(why);
        }
        result
    }

    fn pick_once(bus: &zbus::blocking::Connection, parent_window: &str, start: Option<&[u8]>) -> Result<Option<PathBuf>, PortalError> {
        let token = unique_token();
        let predicted_path = request_path(bus, &token)?;
        let mut iter = subscribe(bus, &predicted_path)?;

        let mut options: HashMap<&str, Value<'_>> =
            HashMap::from([("handle_token", Value::from(token.as_str())), ("directory", Value::from(true)), ("multiple", Value::from(false))]);
        if let Some(bytes) = start {
            options.insert("current_folder", Value::from(bytes));
        }
        let reply = bus
            .call_method(
                Some("org.freedesktop.portal.Desktop"),
                "/org/freedesktop/portal/desktop",
                Some("org.freedesktop.portal.FileChooser"),
                "OpenFile",
                &(parent_window, "Select a Folder", options),
            )
            .map_err(chooser_linux::classify_zbus_error)?;

        // Fix round 1, item 7: an older or nonconforming portal may not honour `handle_token`,
        // returning a different request path than the one we predicted and already subscribed to.
        // Re-matching here narrows, but can't fully close, the window between the portal choosing
        // that path and this resubscribing on it — a response emitted in between would still be
        // missed, same as any signal-based client racing a call's own reply.
        let actual_path: OwnedObjectPath = reply.body().deserialize().map_err(|e| PortalError::Failed(e.to_string()))?;
        if actual_path.as_str() != predicted_path {
            iter = subscribe(bus, actual_path.as_str())?;
        }

        let msg = iter.next().ok_or_else(|| PortalError::Disconnected("the folder-picker portal closed its connection".into()))?.map_err(chooser_linux::classify_zbus_error)?;
        let (response, results): (u32, HashMap<String, OwnedValue>) = msg.body().deserialize().map_err(|e| PortalError::Failed(e.to_string()))?;
        if response != 0 {
            return Ok(None); // cancelled, or another non-zero portal response
        }
        let uris: Vec<String> = results.get("uris").and_then(|v| v.try_clone().ok()).and_then(|v| Vec::<String>::try_from(v).ok()).unwrap_or_default();
        Ok(uris.first().and_then(|u| uri_to_path(u)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;

    #[test]
    fn the_portal_is_used_when_it_answers() {
        let asked = RefCell::new(None);
        let picked = pick_folder(Some(Path::new("/home/ada")), |s| {
            *asked.borrow_mut() = s.map(|p| p.to_path_buf());
            Ok(Some(PathBuf::from("/home/ada/repos")))
        });
        assert_eq!(asked.into_inner().as_deref(), Some(Path::new("/home/ada")));
        assert_eq!(picked.as_deref(), Some(Path::new("/home/ada/repos")));
    }

    #[test]
    fn a_cancel_and_a_missing_portal_both_come_back_as_nothing_picked() {
        assert_eq!(pick_folder(None, |_| Ok(None)), None, "the user cancelled");
        assert_eq!(pick_folder(None, |_| Err(PortalError::Failed("no bus".into()))), None, "no portal: R2, not an error");
        assert_eq!(pick_folder(None, |_| Err(PortalError::TimedOut)), None);
    }

    #[test]
    fn file_uris_decode_to_paths() {
        assert_eq!(uri_to_path("file:///home/ada/My%20Repos"), Some(PathBuf::from("/home/ada/My Repos")));
        assert_eq!(uri_to_path("file://localhost/home/ada"), Some(PathBuf::from("/home/ada")));
        assert_eq!(uri_to_path("not-a-uri"), None);
        assert_eq!(uri_to_path("http://example.com/x"), None);
    }

    #[test]
    fn percent_decode_handles_escapes_and_leaves_the_rest_alone() {
        assert_eq!(percent_decode("a%20b%2Fc"), "a b/c");
        assert_eq!(percent_decode("no-escapes"), "no-escapes");
        assert_eq!(percent_decode("bad%zz escape"), "bad%zz escape");
        assert_eq!(percent_decode("trailing%2"), "trailing%2");
    }
}
