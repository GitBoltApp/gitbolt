// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

use cef::*;

#[cfg(target_os = "linux")]
type CefOsEvent<'a> = Option<&'a mut cef::sys::XEvent>;
#[cfg(target_os = "macos")]
type CefOsEvent<'a> = *mut u8;
#[cfg(windows)]
type CefOsEvent<'a> = Option<&'a mut cef::sys::MSG>;

/// GitBolt patch: the Chrome *reserved* chords GitBolt binds (plan 1C's tabs), which
/// must reach the page. Chrome runs reserved accelerators before the renderer, so
/// without this the page never sees their keydown, even though `command.rs` blocks
/// the command: Ctrl+W / Ctrl+F4 (close tab; closes the open file today), Ctrl+Tab /
/// Ctrl+Shift+Tab / Ctrl+PgUp / Ctrl+PgDn (switch tab) and Ctrl+Shift+T (reopen tab).
/// Exactly those: no Shift except on Tab and T, so Ctrl+Shift+W (close window) and
/// Ctrl+Shift+PgUp/PgDn (move tab) keep Chrome's handling (and `command.rs`'s block).
///
/// Only for the app's own browser (`owned`): a DevTools window or a CEF-owned popup
/// is a real Chrome window, whose reserved keys stay Chrome's.
///
/// `key` is the event's `windows_key_code` (a `VKEY_*` value).
fn gitbolt_passes_to_page(owned: bool, key: i32, ctrl: bool, alt: bool, shift: bool) -> bool {
  owned
    && ctrl
    && !alt
    && match key {
      0x57 /* W */ | 0x73 /* F4 */ | 0x21 /* PgUp */ | 0x22 /* PgDn */ => !shift,
      0x09 /* Tab */ => true,
      0x54 /* T */ => shift,
      _ => false,
    }
}

wrap_keyboard_handler! {
  pub struct TauriCefKeyboardHandler {
    devtools_enabled: bool,
    // GitBolt patch: identifies the app's own browser, as `command.rs`'s `owns()` does.
    frame_navigation_state: crate::FrameNavigationState,
  }

  impl KeyboardHandler {
    fn on_pre_key_event(
      &self,
      browser: Option<&mut Browser>,
      event: Option<&KeyEvent>,
      _os_event: CefOsEvent<'_>,
      _is_keyboard_shortcut: Option<&mut ::std::os::raw::c_int>,
    ) -> ::std::os::raw::c_int {
      // GitBolt patch: opt-in key diagnostic (`GITBOLT_KEY_LOG`, see `command.rs`).
      if super::command::gitbolt_key_log() {
        if let Some(event) = event {
          eprintln!(
            "[gitbolt-keys] pre-key type {:?} key {} modifiers {:#x}",
            event.type_, event.windows_key_code, event.modifiers
          );
        }
      }

      // GitBolt patch: the reserved chords GitBolt binds go to the page first. Per the
      // `OnPreKeyEvent` contract, `is_keyboard_shortcut = 1` and return 0: CEF then
      // skips Chrome's reserved-key pre-processing and sends the event to the renderer;
      // one the page leaves unhandled reaches the accelerator, whose command
      // `command.rs` blocks.
      if let Some(event) = event {
        use cef::sys::{cef_event_flags_t, cef_key_event_type_t};
        let keydown_type: cef::KeyEventType = cef_key_event_type_t::KEYEVENT_RAWKEYDOWN.into();
        #[cfg(windows)]
        let modifiers = event.modifiers as i32;
        #[cfg(not(windows))]
        let modifiers = event.modifiers;
        let flag = |f: cef_event_flags_t| (modifiers & f.0) != 0;
        // The app's own browser only (the frame observer binds its identity on the first
        // frame notification, long before a key can arrive).
        let owned = browser
          .as_ref()
          .is_some_and(|b| self.frame_navigation_state.has_browser_id(b.identifier()));
        if event.type_ == keydown_type
          && gitbolt_passes_to_page(
            owned,
            event.windows_key_code,
            flag(cef_event_flags_t::EVENTFLAG_CONTROL_DOWN),
            flag(cef_event_flags_t::EVENTFLAG_ALT_DOWN),
            flag(cef_event_flags_t::EVENTFLAG_SHIFT_DOWN),
          )
        {
          if let Some(is_keyboard_shortcut) = _is_keyboard_shortcut {
            *is_keyboard_shortcut = 1;
          }
          return 0;
        }
      }

      // If devtools is disabled, block devtools keyboard shortcuts.
      if !self.devtools_enabled {
        let Some(event) = event else {
          return 0;
        };

        // Check if this is a keydown event.
        use cef::sys::cef_key_event_type_t;
        let keydown_type: cef::KeyEventType = cef_key_event_type_t::KEYEVENT_RAWKEYDOWN.into();
        if event.type_ != keydown_type {
          return 0;
        }

        // Get modifier keys.
        use cef::sys::cef_event_flags_t;
        #[cfg(windows)]
        let modifiers = event.modifiers as i32;
        #[cfg(not(windows))]
        let modifiers = event.modifiers;

        #[cfg(not(target_os = "macos"))]
        let ctrl = (modifiers & (cef_event_flags_t::EVENTFLAG_CONTROL_DOWN.0)) != 0;
        #[cfg(not(target_os = "macos"))]
        let shift = (modifiers & (cef_event_flags_t::EVENTFLAG_SHIFT_DOWN.0)) != 0;

        let key_code = event.windows_key_code;

        // Block F12 (key code 123).
        if key_code == 123 {
          if let Some(is_keyboard_shortcut) = _is_keyboard_shortcut {
            *is_keyboard_shortcut = 1;
          }
          return 1;
        }

        // Block Ctrl+Shift+I (key code 73 = 'I') on Linux/Windows.
        #[cfg(not(target_os = "macos"))]
        if key_code == 73 && ctrl && shift {
          if let Some(is_keyboard_shortcut) = _is_keyboard_shortcut {
            *is_keyboard_shortcut = 1;
          }
          return 1;
        }

        // Block Cmd+Opt+I on macOS.
        #[cfg(target_os = "macos")]
        {
          let meta = (modifiers & cef_event_flags_t::EVENTFLAG_COMMAND_DOWN.0) != 0;
          let alt = (modifiers & cef_event_flags_t::EVENTFLAG_ALT_DOWN.0) != 0;
          if key_code == 73 && meta && alt {
            if let Some(is_keyboard_shortcut) = _is_keyboard_shortcut {
              *is_keyboard_shortcut = 1;
            }
            return 1;
          }
        }
      }

      0
    }
  }
}

#[cfg(test)]
mod tests {
  use super::gitbolt_passes_to_page;

  const W: i32 = 0x57;
  const T: i32 = 0x54;
  const TAB: i32 = 0x09;
  const F4: i32 = 0x73;
  const PGUP: i32 = 0x21;
  const PGDN: i32 = 0x22;

  #[test]
  fn the_reserved_tab_and_close_chords_gitbolt_binds_reach_the_page() {
    // (key, shift): Ctrl+W, Ctrl+F4, Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PgUp, Ctrl+PgDn, Ctrl+Shift+T.
    for (key, shift) in [(W, false), (F4, false), (TAB, false), (TAB, true), (PGUP, false), (PGDN, false), (T, true)] {
      assert!(gitbolt_passes_to_page(true, key, true, false, shift), "key {key:#x} shift {shift}");
    }
  }

  #[test]
  fn only_for_the_apps_own_browser() {
    // DevTools and popups keep Chrome's reserved-key handling.
    for (key, shift) in [(W, false), (TAB, false), (T, true)] {
      assert!(!gitbolt_passes_to_page(false, key, true, false, shift), "key {key:#x}");
    }
  }

  #[test]
  fn shifted_close_and_page_chords_take_the_normal_path() {
    // Ctrl+Shift+W (close window), Ctrl+Shift+F4, Ctrl+Shift+PgUp/PgDn (move tab): not bound.
    for key in [W, F4, PGUP, PGDN] {
      assert!(!gitbolt_passes_to_page(true, key, true, false, true), "Ctrl+Shift+{key:#x}");
    }
  }

  #[test]
  fn everything_else_takes_the_normal_path() {
    assert!(!gitbolt_passes_to_page(true, W, false, false, false), "plain W");
    assert!(!gitbolt_passes_to_page(true, W, true, true, false), "Ctrl+Alt+W");
    assert!(!gitbolt_passes_to_page(true, T, true, false, false), "Ctrl+T (new tab) stays blocked as a command");
    assert!(!gitbolt_passes_to_page(true, 0x4E, true, false, true), "Ctrl+Shift+N");
    assert!(!gitbolt_passes_to_page(true, 0x76, false, false, false), "F7 is not reserved");
    assert!(!gitbolt_passes_to_page(true, 0x43, true, false, false), "Ctrl+C");
  }
}
