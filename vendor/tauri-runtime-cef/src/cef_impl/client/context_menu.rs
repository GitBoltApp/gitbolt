// Copyright 2019-2024 Tauri Programme within The Commons Conservancy
// SPDX-License-Identifier: Apache-2.0
// SPDX-License-Identifier: MIT

//! Context menu policy for the webview.
//!
//! The runtime creates Chrome style browsers, so the model handed to
//! `on_before_context_menu` is Chrome's own page context menu — the same one a
//! browser tab shows, with back/forward/reload, save as, print, translate, view
//! page source, "Search the web for…", open link in a new tab/window/incognito
//! window and Inspect. Alloy style would have handed us a small menu addressed
//! by the `MENU_ID_*` constants; a Chrome style model carries IDC command ids
//! instead, so those constants are useless here and entries have to be matched
//! by IDC id.
//!
//! This file filters that model down to the entries that mean something inside
//! an application window. Removing by command id is exact, is a no-op when the
//! entry is not in this particular menu, and does not care what order Chrome
//! lays the menu out in.

use std::{ffi::CStr, os::raw::c_int, sync::OnceLock};

use cef::{
  resources,
  sys::{cef_id_for_command_id_name, cef_menu_item_type_t},
  *,
};

/// Entries that navigate, print, save, or hand the page to a web service. None
/// of them belong in an application window, and most of them lead somewhere the
/// app has no control over.
///
/// Everything not listed here is kept, which covers what an app genuinely
/// wants: undo/redo, cut/copy/paste (including paste as plain text), delete,
/// select all, the spellcheck suggestions and add-to-dictionary, emoji, and the
/// copy-link-address / copy-image family.
const BROWSER_ONLY_COMMANDS: &[&CStr] = &[
  // Navigation and page lifecycle.
  resources::IDC_BACK,
  resources::IDC_FORWARD,
  resources::IDC_RELOAD,
  resources::IDC_RELOAD_BYPASSING_CACHE,
  resources::IDC_RELOAD_CLEARING_CACHE,
  resources::IDC_CONTENT_CONTEXT_RELOADFRAME,
  // Saving, printing, and looking behind the page.
  resources::IDC_SAVE_PAGE,
  resources::IDC_PRINT,
  resources::IDC_BASIC_PRINT,
  resources::IDC_VIEW_SOURCE,
  resources::IDC_CONTENT_CONTEXT_VIEWFRAMESOURCE,
  resources::IDC_CONTENT_CONTEXT_SAVELINKAS,
  resources::IDC_CONTENT_CONTEXT_SAVEIMAGEAS,
  resources::IDC_CONTENT_CONTEXT_SAVEAVAS,
  resources::IDC_CONTENT_CONTEXT_SAVEPLUGINAS,
  resources::IDC_CONTENT_CONTEXT_SAVEVIDEOFRAMEAS,
  // Opening a browser surface the app does not own.
  resources::IDC_CONTENT_CONTEXT_OPENLINKNEWTAB,
  resources::IDC_CONTENT_CONTEXT_OPENLINKNEWWINDOW,
  resources::IDC_CONTENT_CONTEXT_OPENLINKOFFTHERECORD,
  resources::IDC_CONTENT_CONTEXT_OPENLINKINPROFILE,
  resources::IDC_CONTENT_CONTEXT_OPENLINKBOOKMARKAPP,
  resources::IDC_CONTENT_CONTEXT_OPENLINKSPLITVIEW,
  resources::IDC_CONTENT_CONTEXT_OPENIMAGENEWTAB,
  resources::IDC_CONTENT_CONTEXT_OPEN_ORIGINAL_IMAGE_NEW_TAB,
  resources::IDC_CONTENT_CONTEXT_OPENAVNEWTAB,
  resources::IDC_CONTENT_CONTEXT_GOTOURL,
  resources::IDC_CONTENT_CONTEXT_OPEN_IN_READING_MODE,
  resources::IDC_CONTENT_CONTEXT_ADD_LINK_TO_READING_LIST,
  // Sending the page, a selection, or a frame off to a web service.
  resources::IDC_CONTENT_CONTEXT_TRANSLATE,
  resources::IDC_CONTENT_CONTEXT_PARTIAL_TRANSLATE,
  resources::IDC_CONTENT_CONTEXT_SEARCHWEBFOR,
  resources::IDC_CONTENT_CONTEXT_SEARCHWEBFORNEWTAB,
  resources::IDC_CONTENT_CONTEXT_SEARCHWEBFORIMAGE,
  resources::IDC_CONTENT_CONTEXT_SEARCHWEBFORVIDEOFRAME,
  resources::IDC_CONTENT_CONTEXT_SEARCHLENSFORIMAGE,
  resources::IDC_CONTENT_CONTEXT_SEARCHLENSFORVIDEOFRAME,
  resources::IDC_CONTENT_CONTEXT_LENS_OVERLAY,
  resources::IDC_CONTENT_CONTEXT_LENS_REGION_SEARCH,
  resources::IDC_CONTENT_CONTEXT_WEB_REGION_SEARCH,
  resources::IDC_CONTENT_CONTEXT_SHARING_SUBMENU,
  resources::IDC_CONTENT_CONTEXT_GENERATE_QR_CODE,
  resources::IDC_ROUTE_MEDIA,
  // GitBolt patch (H19): Chrome's text-fragment links. "Copy link to highlight" hands the user
  // a `http://tauri.localhost/#:~:text=…` URL, which means nothing outside the app window.
  resources::IDC_CONTENT_CONTEXT_COPYLINKTOTEXT,
  resources::IDC_CONTENT_CONTEXT_RESHARELINKTOTEXT,
  resources::IDC_CONTENT_CONTEXT_REMOVELINKTOTEXT,
  // GitBolt patch (H19): Chrome's AI, reading and sharing services, which hand the page to
  // Google or to the user's other devices.
  resources::IDC_CONTENT_CONTEXT_GLIC,
  resources::IDC_CONTENT_CONTEXT_GLICSHAREIMAGE,
  resources::IDC_CONTENT_CONTEXT_RELOAD_GLIC,
  resources::IDC_CONTENT_CONTEXT_ARCHIVE_GLIC,
  resources::IDC_CONTENT_CONTEXT_LISTEN_TO_THIS_PAGE,
  resources::IDC_CONTENT_CONTEXT_SAVE_TO_MEMORY_BANKS,
  resources::IDC_CONTENT_CONTEXT_QUICK_ANSWERS_INLINE_ANSWER,
  resources::IDC_CONTENT_CONTEXT_QUICK_ANSWERS_INLINE_QUERY,
  resources::IDC_CONTENT_CONTEXT_SEND_TAB_TO_SELF_DEVICE1,
  resources::IDC_CONTENT_CONTEXT_SEND_TAB_TO_SELF_MANAGE_DEVICES,
  resources::IDC_CONTENT_CONTEXT_ACCESSIBILITY_LABELS_TOGGLE,
  resources::IDC_CONTENT_CONTEXT_ACCESSIBILITY_LABELS_TOGGLE_ONCE,
  // GitBolt patch (H19): password and address autofill; the app has no web forms.
  resources::IDC_CONTENT_CONTEXT_SHOWALLSAVEDPASSWORDS,
  resources::IDC_CONTENT_CONTEXT_GENERATEPASSWORD,
  resources::IDC_CONTENT_CONTEXT_USE_PASSKEY_FROM_ANOTHER_DEVICE,
  resources::IDC_CONTENT_CONTEXT_AUTOFILL_FEEDBACK,
  resources::IDC_CONTENT_CONTEXT_AUTOFILL_FALLBACK_PLUS_ADDRESS,
  resources::IDC_CONTENT_CONTEXT_AUTOFILL_FALLBACK_PASSWORDS_SELECT_PASSWORD,
  resources::IDC_CONTENT_CONTEXT_AUTOFILL_FALLBACK_PASSWORDS_IMPORT_PASSWORDS,
  resources::IDC_CONTENT_CONTEXT_AUTOFILL_FALLBACK_PASSWORDS_SUGGEST_PASSWORD,
  resources::IDC_CONTENT_CONTEXT_AUTOFILL_FALLBACK_PASSWORDS_USE_PASSKEY_FROM_ANOTHER_DEVICE,
  resources::IDC_CONTENT_CONTEXT_AUTOFILL_FALLBACK_AT_MEMORY,
  resources::IDC_CONTENT_CONTEXT_PROTOCOL_HANDLER_SETTINGS,
  // GitBolt patch (H19): an image's address is a `blob:` URL; Copy image stays.
  resources::IDC_CONTENT_CONTEXT_COPYIMAGELOCATION,
];

/// Entries that open DevTools. Kept when the webview enables devtools, removed
/// otherwise.
const DEVTOOLS_COMMANDS: &[&CStr] = &[
  resources::IDC_CONTENT_CONTEXT_INSPECTELEMENT,
  resources::IDC_CONTENT_CONTEXT_INSPECTELEMENT_WITH_DEVTOOLS,
  resources::IDC_CONTENT_CONTEXT_INSPECTBACKGROUNDPAGE,
  resources::IDC_DEV_TOOLS,
  resources::IDC_DEV_TOOLS_INSPECT,
  resources::IDC_DEV_TOOLS_CONSOLE,
  resources::IDC_DEV_TOOLS_DEVICES,
  resources::IDC_DEV_TOOLS_TOGGLE,
];

/// What [`cef_id_for_command_id_name`] answers for an IDC name the running CEF
/// build does not know, and also what CEF reports as the command id of an entry
/// that has none (a separator, or an out of range index). An unresolved name
/// must therefore never reach `remove`, or it would delete an arbitrary entry —
/// [`resolve_command_ids`] drops these instead.
const UNKNOWN_COMMAND_ID: c_int = -1;

struct CommandIds {
  browser_only: Vec<c_int>,
  devtools: Vec<c_int>,
}

/// The IDC names above, resolved to the numeric command ids of the running CEF
/// build.
///
/// The mapping is build specific but fixed for the life of the process, so it is
/// resolved once rather than on every right click — this runs on the UI thread
/// while the user waits for the menu. Resolving lazily also keeps the lookups
/// after CEF initialization.
fn command_ids() -> &'static CommandIds {
  static COMMAND_IDS: OnceLock<CommandIds> = OnceLock::new();

  COMMAND_IDS.get_or_init(|| CommandIds {
    browser_only: resolve_command_ids(BROWSER_ONLY_COMMANDS),
    devtools: resolve_command_ids(DEVTOOLS_COMMANDS),
  })
}

fn resolve_command_ids(names: &[&CStr]) -> Vec<c_int> {
  names
    .iter()
    // SAFETY: the pointer comes from a `&'static CStr`, so it is a valid NUL
    // terminated string that outlives the call.
    .map(|name| unsafe { cef_id_for_command_id_name(name.as_ptr()) })
    .filter(|id| *id != UNKNOWN_COMMAND_ID)
    .collect()
}

/// Drops the separators the removals leave behind: a menu must not open or end
/// with one, and two in a row draw as a double rule.
///
/// Every loop here advances on a failed `remove_at`. A removal CEF refuses does
/// not shrink `count()`, so retrying it would spin on CEF's UI thread, which this
/// runtime drives with an external message pump — hanging the whole application
/// rather than just the menu.
fn remove_redundant_separators(model: &MenuModel) {
  let separator = MenuItemType::from(cef_menu_item_type_t::MENUITEMTYPE_SEPARATOR);
  let is_separator = |index: usize| model.type_at(index) == separator;
  let removed = |result: c_int| result != 0;

  // Starting as if a separator had just been seen also drops the leading ones.
  let mut previous_was_separator = true;
  let mut index = 0;
  while index < model.count() {
    if is_separator(index) {
      if previous_was_separator && removed(model.remove_at(index)) {
        // The entries after `index` shifted down into it, so the same index is
        // the next entry to look at. Only a removal that actually happened may
        // hold the index still.
        continue;
      }
      previous_was_separator = true;
    } else {
      previous_was_separator = false;
    }
    index += 1;
  }

  while model.count() > 0
    && is_separator(model.count() - 1)
    && removed(model.remove_at(model.count() - 1))
  {}
}

wrap_context_menu_handler! {
  pub struct TauriCefContextMenuHandler {
    devtools_enabled: bool,
  }

  impl ContextMenuHandler {
    fn on_before_context_menu(
      &self,
      _browser: Option<&mut Browser>,
      _frame: Option<&mut Frame>,
      _params: Option<&mut ContextMenuParams>,
      model: Option<&mut MenuModel>,
    ) {
      let Some(model) = model else {
        return;
      };

      // Removing a command this menu does not carry is a no-op, so the whole
      // policy can be applied to every menu without first asking `params` which
      // kind of menu it is.
      let command_ids = command_ids();
      for id in &command_ids.browser_only {
        model.remove(*id);
      }
      if !self.devtools_enabled {
        for id in &command_ids.devtools {
          model.remove(*id);
        }
      }

      remove_redundant_separators(model);

      // An empty model is left empty on purpose: CEF then shows no menu at all,
      // which is the right outcome for a menu with nothing in it.
    }
  }
}

/// GitBolt patch (tests only): CEF builds its IDC name table lazily on the first lookup, and two
/// first lookups on different threads race (a name then resolves to -1). The app only looks names
/// up on CEF's UI thread; tests that do, on the harness's threads, hold this lock.
#[cfg(test)]
pub(crate) static NAME_LOOKUP: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
  use super::*;

  /// GitBolt patch (H19): what the app's text menu must not offer. "Copy link to highlight"
  /// (a `#:~:text=` link to `tauri.localhost`) and its siblings, Chrome's AI / reading / sharing
  /// services, password and address autofill, and "copy image address" (a `blob:` URL).
  #[test]
  fn gitbolt_drops_text_fragment_links_and_chrome_services() {
    for name in [
      resources::IDC_CONTENT_CONTEXT_COPYLINKTOTEXT,
      resources::IDC_CONTENT_CONTEXT_RESHARELINKTOTEXT,
      resources::IDC_CONTENT_CONTEXT_REMOVELINKTOTEXT,
      resources::IDC_CONTENT_CONTEXT_GLIC,
      resources::IDC_CONTENT_CONTEXT_GLICSHAREIMAGE,
      resources::IDC_CONTENT_CONTEXT_LISTEN_TO_THIS_PAGE,
      resources::IDC_CONTENT_CONTEXT_SAVE_TO_MEMORY_BANKS,
      resources::IDC_CONTENT_CONTEXT_SEND_TAB_TO_SELF_DEVICE1,
      resources::IDC_CONTENT_CONTEXT_ACCESSIBILITY_LABELS_TOGGLE,
      resources::IDC_CONTENT_CONTEXT_SHOWALLSAVEDPASSWORDS,
      resources::IDC_CONTENT_CONTEXT_GENERATEPASSWORD,
      resources::IDC_CONTENT_CONTEXT_AUTOFILL_FEEDBACK,
      resources::IDC_CONTENT_CONTEXT_COPYIMAGELOCATION,
      // Already upstream's: web search, print, Lens.
      resources::IDC_CONTENT_CONTEXT_SEARCHWEBFOR,
      resources::IDC_PRINT,
      resources::IDC_CONTENT_CONTEXT_LENS_REGION_SEARCH,
    ] {
      assert!(BROWSER_ONLY_COMMANDS.contains(&name), "{name:?} is still offered");
    }
  }

  /// The editing entries stay, and Inspect goes only with devtools (off in release builds).
  #[test]
  fn editing_entries_stay_and_inspect_goes_with_devtools() {
    for name in [
      resources::IDC_CONTENT_CONTEXT_COPY,
      resources::IDC_CONTENT_CONTEXT_CUT,
      resources::IDC_CONTENT_CONTEXT_PASTE,
      resources::IDC_CONTENT_CONTEXT_SELECTALL,
      resources::IDC_CONTENT_CONTEXT_COPYIMAGE,
      resources::IDC_CONTENT_CONTEXT_COPYLINKLOCATION,
    ] {
      assert!(!BROWSER_ONLY_COMMANDS.contains(&name), "{name:?} dropped");
      assert!(!DEVTOOLS_COMMANDS.contains(&name), "{name:?} dropped with devtools");
    }
    assert!(DEVTOOLS_COMMANDS.contains(&resources::IDC_CONTENT_CONTEXT_INSPECTELEMENT));
  }

  #[test]
  fn every_name_resolves_to_a_command_id_in_this_cef_build() {
    let _lookup = NAME_LOOKUP.lock().unwrap_or_else(|e| e.into_inner());
    for name in BROWSER_ONLY_COMMANDS.iter().chain(DEVTOOLS_COMMANDS) {
      let id = unsafe { cef_id_for_command_id_name(name.as_ptr()) };
      assert_ne!(id, UNKNOWN_COMMAND_ID, "{name:?} is unknown to this CEF build");
    }
  }
}
