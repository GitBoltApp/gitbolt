// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! GitBolt patch: the window manager's `WM_TAKE_FOCUS` gives the keyboard to the CEF browser.
//!
//! GDK advertises `WM_TAKE_FOCUS` on its toplevels and answers it by putting the X input focus
//! on the toplevel's own 1x1 InputOnly "focus window". The CEF browsers are X children of
//! [`super::CefX11Host`], not of that focus window, so from then on the X server delivers every
//! key to GDK, and GTK has nothing to hand it on to: the browser receives no key at all.
//! A window manager sends `WM_TAKE_FOCUS` each time it focuses the window, and mutter does so
//! on every click inside it. Chromium's own activation can't take the focus back under a window
//! manager: it asks with `_NET_ACTIVE_WINDOW` for its child window, which mutter ignores.
//!
//! So each toplevel answers `WM_TAKE_FOCUS` itself, the way CEF's own X11 host window does
//! (`CefWindowX11::Focus`): the focus goes to the topmost viewable browser window in the X11
//! host, with the message's timestamp. GDK's handler only runs when there is no such browser.

use std::os::raw::c_ulong;

use gtk::{glib, prelude::*};
use x11_dl::xlib;

use super::utils::xlib_fns;

/// Handler for one toplevel's `WM_TAKE_FOCUS`, disconnected on drop.
pub(super) struct TakeFocusRedirect {
  display: gdk4_x11::X11Display,
  handler: Option<glib::SignalHandlerId>,
}

impl Drop for TakeFocusRedirect {
  fn drop(&mut self) {
    if let Some(handler) = self.handler.take() {
      self.display.disconnect(handler);
    }
  }
}

/// The timestamp of `event` if it is the window manager's `WM_TAKE_FOCUS` for `toplevel`.
pub(super) fn take_focus_time(
  event: &xlib::XEvent,
  toplevel: c_ulong,
  wm_protocols: c_ulong,
  wm_take_focus: c_ulong,
) -> Option<c_ulong> {
  if event.get_type() != xlib::ClientMessage {
    return None;
  }
  // SAFETY: the event type says the client message variant is the one in use.
  let message = unsafe { event.client_message };
  (message.window == toplevel
    && message.message_type == wm_protocols
    && message.format == 32
    && message.data.get_long(0) as c_ulong == wm_take_focus)
    .then(|| message.data.get_long(1) as c_ulong)
}

/// The browser window to focus among the X11 host's children, bottom to top as `XQueryTree`
/// lists them, each with whether it is viewable: the topmost viewable one.
pub(super) fn focus_target(children: &[(c_ulong, bool)]) -> Option<c_ulong> {
  children
    .iter()
    .rev()
    .find(|(_, viewable)| *viewable)
    .map(|(xid, _)| *xid)
}

/// Answers `WM_TAKE_FOCUS` for `toplevel` by focusing a browser in `host` (see the module docs).
pub(super) fn redirect_take_focus(
  display: &gtk::gdk::Display,
  toplevel: c_ulong,
  host: c_ulong,
) -> Option<TakeFocusRedirect> {
  let display = display.clone().downcast::<gdk4_x11::X11Display>().ok()?;
  let wm_protocols = gdk4_x11::x11_get_xatom_by_name_for_display(&display, "WM_PROTOCOLS");
  let wm_take_focus = gdk4_x11::x11_get_xatom_by_name_for_display(&display, "WM_TAKE_FOCUS");

  // SAFETY: the handler only reads the event GDK passes it and makes Xlib calls on GDK's own
  // display, on the GTK main thread that emits the signal.
  let handler = unsafe {
    display.connect_xevent(move |display, event| {
      let Some(time) = take_focus_time(&*event, toplevel, wm_protocols, wm_take_focus) else {
        return glib::Propagation::Proceed;
      };
      let Some(xlib) = xlib_fns() else {
        return glib::Propagation::Proceed;
      };
      let xdisplay = display.xdisplay();

      display.error_trap_push();
      let target = focus_target(&host_children(xlib, xdisplay, host));
      if let Some(target) = target {
        (xlib.XSetInputFocus)(xdisplay, target, xlib::RevertToParent, time);
        (xlib.XFlush)(xdisplay);
      }
      display.error_trap_pop_ignored();

      if crate::cef_impl::client::gitbolt_key_log() {
        match target {
          Some(target) => eprintln!(
            "[gitbolt-keys] WM_TAKE_FOCUS 0x{toplevel:x} time {time}: X focus -> browser 0x{target:x}"
          ),
          None => eprintln!(
            "[gitbolt-keys] WM_TAKE_FOCUS 0x{toplevel:x} time {time}: no viewable browser, GDK takes it"
          ),
        }
      }

      if target.is_some() {
        glib::Propagation::Stop
      } else {
        glib::Propagation::Proceed
      }
    })
  };

  Some(TakeFocusRedirect {
    display,
    handler: Some(handler),
  })
}

/// The X11 host's children, bottom to top, each with whether it is viewable.
///
/// # Safety
/// `display` must be a live Xlib display; X errors must be trapped by the caller.
unsafe fn host_children(
  xlib: &xlib::Xlib,
  display: *mut xlib::Display,
  host: c_ulong,
) -> Vec<(c_ulong, bool)> {
  unsafe {
    let mut root = 0;
    let mut parent = 0;
    let mut children: *mut xlib::Window = std::ptr::null_mut();
    let mut count = 0;
    if (xlib.XQueryTree)(
      display,
      host,
      &mut root,
      &mut parent,
      &mut children,
      &mut count,
    ) == 0
    {
      return Vec::new();
    }
    let list = if children.is_null() {
      Vec::new()
    } else {
      std::slice::from_raw_parts(children, count as usize)
        .iter()
        .map(|&child| {
          let mut attributes = std::mem::MaybeUninit::<xlib::XWindowAttributes>::uninit();
          let viewable = (xlib.XGetWindowAttributes)(display, child, attributes.as_mut_ptr()) != 0
            && attributes.assume_init().map_state == xlib::IsViewable;
          (child, viewable)
        })
        .collect()
    };
    if !children.is_null() {
      (xlib.XFree)(children.cast());
    }
    list
  }
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::os::raw::c_long;

  const TOPLEVEL: c_ulong = 0xc0_0008;
  const WM_PROTOCOLS: c_ulong = 300;
  const WM_TAKE_FOCUS: c_ulong = 318;
  const WM_DELETE_WINDOW: c_ulong = 301;

  fn client_message(window: c_ulong, message_type: c_ulong, data: [i64; 2]) -> xlib::XEvent {
    let mut event: xlib::XEvent = unsafe { std::mem::zeroed() };
    event.client_message = xlib::XClientMessageEvent {
      type_: xlib::ClientMessage,
      serial: 0,
      send_event: 1,
      display: std::ptr::null_mut(),
      window,
      message_type,
      format: 32,
      data: xlib::ClientMessageData::from([data[0] as c_long, data[1] as c_long, 0, 0, 0]),
    };
    event
  }

  #[test]
  fn the_window_managers_take_focus_for_this_toplevel_is_answered_with_its_timestamp() {
    let event = client_message(
      TOPLEVEL,
      WM_PROTOCOLS,
      [WM_TAKE_FOCUS as i64, 1_187_027_382],
    );
    assert_eq!(
      take_focus_time(&event, TOPLEVEL, WM_PROTOCOLS, WM_TAKE_FOCUS),
      Some(1_187_027_382)
    );
    // CurrentTime, as mutter sends when it has no event time.
    let event = client_message(TOPLEVEL, WM_PROTOCOLS, [WM_TAKE_FOCUS as i64, 0]);
    assert_eq!(
      take_focus_time(&event, TOPLEVEL, WM_PROTOCOLS, WM_TAKE_FOCUS),
      Some(0)
    );
  }

  #[test]
  fn everything_else_is_left_to_gdk() {
    // Another toplevel's take-focus, another WM protocol, another message type.
    for event in [
      client_message(TOPLEVEL + 1, WM_PROTOCOLS, [WM_TAKE_FOCUS as i64, 5]),
      client_message(TOPLEVEL, WM_PROTOCOLS, [WM_DELETE_WINDOW as i64, 5]),
      client_message(TOPLEVEL, WM_TAKE_FOCUS, [WM_TAKE_FOCUS as i64, 5]),
    ] {
      assert_eq!(
        take_focus_time(&event, TOPLEVEL, WM_PROTOCOLS, WM_TAKE_FOCUS),
        None
      );
    }
    // Not a client message at all (a FocusIn with the same bytes).
    let mut focus_in = client_message(TOPLEVEL, WM_PROTOCOLS, [WM_TAKE_FOCUS as i64, 5]);
    focus_in.type_ = xlib::FocusIn;
    assert_eq!(
      take_focus_time(&focus_in, TOPLEVEL, WM_PROTOCOLS, WM_TAKE_FOCUS),
      None
    );
  }

  /// The real thing against an X server: a GTK4 toplevel, an X11 host and a "browser" window
  /// made by another X client (as CEF's are), and the window manager's `WM_TAKE_FOCUS`.
  /// Without the redirect GDK puts the focus on its own focus window and the browser never
  /// gets a key. Ignored by default, since it must never run on a real session: it needs a
  /// throwaway server, named explicitly:
  /// `Xvfb :77 & GITBOLT_X11_TEST_DISPLAY=:77 cargo test -p tauri-runtime-cef --lib focus -- --ignored`
  #[test]
  #[ignore = "needs a throwaway X server in GITBOLT_X11_TEST_DISPLAY (e.g. Xvfb :77)"]
  fn wm_take_focus_puts_the_x_focus_on_the_browser_window() {
    use std::time::{Duration, Instant};

    let display_name = std::env::var("GITBOLT_X11_TEST_DISPLAY")
      .expect("GITBOLT_X11_TEST_DISPLAY names the throwaway X server to use");
    // SAFETY: set before GTK or Xlib start, and no other test in this binary reads them.
    unsafe {
      std::env::set_var("DISPLAY", &display_name);
      std::env::set_var("GDK_BACKEND", "x11");
    }
    gtk::init().expect("GTK on the test X server");
    let xlib = xlib_fns().expect("libX11");

    let window = gtk::Window::new();
    window.set_default_size(200, 200);
    window.present();
    let pump_until = |done: &dyn Fn() -> bool| {
      let deadline = Instant::now() + Duration::from_secs(3);
      while !done() && Instant::now() < deadline {
        glib::MainContext::default().iteration(false);
        std::thread::sleep(Duration::from_millis(5));
      }
    };
    pump_until(&|| window.is_mapped());
    let toplevel = window
      .surface()
      .and_downcast::<gdk4_x11::X11Surface>()
      .expect("an X11 surface")
      .xid();

    unsafe {
      // Another client, like CEF's own X connection.
      let other = (xlib.XOpenDisplay)(std::ptr::null());
      assert!(!other.is_null());
      let host = (xlib.XCreateSimpleWindow)(other, toplevel, 0, 0, 200, 200, 0, 0, 0);
      let browser = (xlib.XCreateSimpleWindow)(other, host, 0, 0, 200, 200, 0, 0, 0);
      (xlib.XMapWindow)(other, browser);
      (xlib.XMapWindow)(other, host);
      (xlib.XSync)(other, 0);

      let _redirect =
        redirect_take_focus(&WidgetExt::display(&window), toplevel, host).expect("an X11 display");

      // The window manager's message, delivered to the toplevel's owner (GDK).
      let atom = |name: &std::ffi::CStr| (xlib.XInternAtom)(other, name.as_ptr(), 0);
      let mut event: xlib::XEvent = std::mem::zeroed();
      event.client_message = xlib::XClientMessageEvent {
        type_: xlib::ClientMessage,
        serial: 0,
        send_event: 1,
        display: other,
        window: toplevel,
        message_type: atom(c"WM_PROTOCOLS"),
        format: 32,
        data: xlib::ClientMessageData::from([atom(c"WM_TAKE_FOCUS") as c_long, 0, 0, 0, 0]),
      };
      (xlib.XSendEvent)(other, toplevel, 0, 0, &mut event);
      (xlib.XSync)(other, 0);

      let focus = || {
        let (mut focus, mut revert) = (0, 0);
        (xlib.XGetInputFocus)(other, &mut focus, &mut revert);
        focus
      };
      pump_until(&|| focus() == browser);
      // Keep pumping: GDK must not take it back to its focus window afterwards.
      let settle = Instant::now() + Duration::from_millis(300);
      while Instant::now() < settle {
        glib::MainContext::default().iteration(false);
        std::thread::sleep(Duration::from_millis(5));
      }
      assert_eq!(focus(), browser, "the X focus is on the browser window");
      (xlib.XCloseDisplay)(other);
    }
  }

  #[test]
  fn the_focus_goes_to_the_topmost_viewable_browser() {
    assert_eq!(focus_target(&[(1, true)]), Some(1));
    assert_eq!(focus_target(&[(1, true), (2, true)]), Some(2));
    // A hidden (unmapped) browser on top is skipped.
    assert_eq!(focus_target(&[(1, true), (2, false)]), Some(1));
    // No browser yet, or none shown: GDK's own handling runs.
    assert_eq!(focus_target(&[]), None);
    assert_eq!(focus_target(&[(1, false)]), None);
  }
}
