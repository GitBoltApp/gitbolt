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
  // GitBolt patch (spell check): "Use enhanced spell check" hands the text to Google's spelling
  // service, and "Language settings" opens a `chrome://settings` tab. The suggestions and
  // add-to-dictionary stay; the dictionary is the one the app bundles.
  resources::IDC_CONTENT_CONTEXT_SPELLING_TOGGLE,
  resources::IDC_CONTENT_CONTEXT_LANGUAGE_SETTINGS,
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

fn menu_item_type(t: cef_menu_item_type_t) -> MenuItemType {
  MenuItemType::from(t)
}

/// What the three menu-cleanup passes below need from a menu model, abstracted so they can run
/// against a plain in-memory fake in tests: `menu_model_create` returns `None` outside a running
/// browser process (confirmed with a scratch test), so there is no way to build a real
/// `MenuModel` to populate and check here. Method names are distinct from `ImplMenuModel`'s own
/// (`item_count`, not `count`, and so on), so `MenuModel`'s implementation below can still call
/// through to CEF's real methods without the two colliding.
trait MenuModelLike: Sized {
  fn item_count(&self) -> usize;
  fn is_separator_at(&self, index: usize) -> bool;
  fn is_submenu_at(&self, index: usize) -> bool;
  fn child_menu_at(&self, index: usize) -> Option<Self>;
  /// Whether `command_id` was found (anywhere in this level) and removed.
  fn remove_command(&self, command_id: c_int) -> bool;
  /// Whether `index` was in range and got removed.
  fn remove_item_at(&self, index: usize) -> bool;
}

impl MenuModelLike for MenuModel {
  fn item_count(&self) -> usize {
    self.count()
  }
  fn is_separator_at(&self, index: usize) -> bool {
    self.type_at(index) == menu_item_type(cef_menu_item_type_t::MENUITEMTYPE_SEPARATOR)
  }
  fn is_submenu_at(&self, index: usize) -> bool {
    self.type_at(index) == menu_item_type(cef_menu_item_type_t::MENUITEMTYPE_SUBMENU)
  }
  fn child_menu_at(&self, index: usize) -> Option<Self> {
    self.sub_menu_at(index)
  }
  fn remove_command(&self, command_id: c_int) -> bool {
    self.remove(command_id) != 0
  }
  fn remove_item_at(&self, index: usize) -> bool {
    self.remove_at(index) != 0
  }
}

/// Removes `command_id` from `model` or, failing that, from any of its submenus, depth first.
///
/// `MenuModel::remove` only searches the level it's called on: Chrome nests some of the entries
/// this policy targets one level down (the autofill-fallback password items live under a
/// passwords submenu, and the accessibility-labels toggle under an accessibility submenu), so a
/// plain top-level `remove` is a silent no-op for them. Returns whether something was actually
/// removed, so a caller can tell a hit from "never in this menu" without walking it itself.
fn remove_recursive<M: MenuModelLike>(model: &M, command_id: c_int) -> bool {
  if model.remove_command(command_id) {
    return true;
  }
  let mut index = 0;
  while index < model.item_count() {
    if model.is_submenu_at(index) {
      if let Some(sub) = model.child_menu_at(index) {
        if remove_recursive(&sub, command_id) {
          return true;
        }
      }
    }
    index += 1;
  }
  false
}

/// Drops a submenu item left with nothing in it, depth first: a parent whose every child
/// `remove_recursive` removed (the passwords or accessibility submenu, once its entries are all
/// gone) would otherwise linger in the menu, open to nothing.
///
/// Fix round 1, item 6: this is how the parent containers get removed. The autofill-fallback
/// passwords and accessibility-labels submenus have no stable id of their own to target by —
/// Chromium assigns them a plain runtime command id with no entry in this CEF build's name
/// table (unlike, say, `IDC_CONTENT_CONTEXT_SHARING_SUBMENU`, checked against every resource
/// file in the crate) — so removing them by id, as the leaf items are, isn't possible. Emptying
/// them structurally and then dropping the empty shell reaches the same result without one.
///
/// `remove_redundant_separators` runs on each submenu first: a submenu whose *items* were all
/// removed can still hold only separators between (and around) where they were, which is not
/// what `item_count() == 0` sees as empty. Its own leading/trailing/double-separator sweep
/// reduces that to nothing when the submenu truly has no real entries left.
///
/// Every loop here advances on a failed `remove_item_at`, for the same reason as
/// `remove_redundant_separators`: a removal CEF refuses doesn't shrink `item_count()`, and
/// retrying it would spin on CEF's UI thread instead of just leaving that one entry alone.
fn remove_empty_submenus<M: MenuModelLike>(model: &M) {
  let mut index = 0;
  while index < model.item_count() {
    if model.is_submenu_at(index) {
      if let Some(sub) = model.child_menu_at(index) {
        remove_empty_submenus(&sub);
        remove_redundant_separators(&sub);
        if sub.item_count() == 0 && model.remove_item_at(index) {
          continue;
        }
      }
    }
    index += 1;
  }
}

/// Drops the separators the removals leave behind: a menu must not open or end
/// with one, and two in a row draw as a double rule.
///
/// Every loop here advances on a failed `remove_item_at`. A removal CEF refuses does
/// not shrink `item_count()`, so retrying it would spin on CEF's UI thread, which this
/// runtime drives with an external message pump — hanging the whole application
/// rather than just the menu.
fn remove_redundant_separators<M: MenuModelLike>(model: &M) {
  // Starting as if a separator had just been seen also drops the leading ones.
  let mut previous_was_separator = true;
  let mut index = 0;
  while index < model.item_count() {
    if model.is_separator_at(index) {
      if previous_was_separator && model.remove_item_at(index) {
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

  while model.item_count() > 0
    && model.is_separator_at(model.item_count() - 1)
    && model.remove_item_at(model.item_count() - 1)
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
      // kind of menu it is. `remove_recursive` also reaches into submenus (GitBolt
      // patch, deferred minor #15): some of these entries are nested one level
      // down, where a plain `remove` would silently miss them.
      let command_ids = command_ids();
      for id in &command_ids.browser_only {
        remove_recursive(model, *id);
      }
      if !self.devtools_enabled {
        for id in &command_ids.devtools {
          remove_recursive(model, *id);
        }
      }

      remove_empty_submenus(model);
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

/// GitBolt patch (tests only): on macOS nothing links CEF's framework (the app loads it from its
/// bundle at startup), and a call into CEF before that is a null function pointer. A test that
/// looks a name up loads it first, from the distribution the build used (build.rs). A no-op
/// elsewhere, where the test binary links libcef.
#[cfg(test)]
pub(crate) fn load_cef_for_tests() {
  #[cfg(target_os = "macos")]
  {
    static LOADED: std::sync::Once = std::sync::Once::new();
    LOADED.call_once(|| {
      let dir = option_env!("GITBOLT_TEST_CEF_DIR").expect("the CEF distribution (build.rs)");
      let framework = format!("{dir}/Chromium Embedded Framework.framework/Chromium Embedded Framework");
      let path = std::ffi::CString::new(framework.as_str()).unwrap();
      // SAFETY: a NUL-terminated path that outlives the call. The framework stays loaded.
      assert_eq!(cef::load_library(Some(unsafe { &*path.as_ptr() })), 1, "couldn't load {framework}");
      let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
    });
  }
}

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

  /// GitBolt patch (spell check): the suggestions and the dictionary entries stay; "Use enhanced
  /// spell check" (sends the text to Google's spelling service) and "Language settings" (a
  /// `chrome://settings` page) go.
  #[test]
  fn spelling_suggestions_stay_and_googles_spelling_service_goes() {
    for name in [
      resources::IDC_CONTENT_CONTEXT_SPELLING_TOGGLE,
      resources::IDC_CONTENT_CONTEXT_LANGUAGE_SETTINGS,
    ] {
      assert!(BROWSER_ONLY_COMMANDS.contains(&name), "{name:?} is still offered");
    }
    for name in [
      resources::IDC_SPELLCHECK_SUGGESTION_0,
      resources::IDC_SPELLCHECK_ADD_TO_DICTIONARY,
      resources::IDC_SPELLCHECK_REMOVE_FROM_DICTIONARY,
      resources::IDC_CHECK_SPELLING_WHILE_TYPING,
    ] {
      assert!(!BROWSER_ONLY_COMMANDS.contains(&name), "{name:?} dropped");
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
    load_cef_for_tests();
    for name in BROWSER_ONLY_COMMANDS.iter().chain(DEVTOOLS_COMMANDS) {
      let id = unsafe { cef_id_for_command_id_name(name.as_ptr()) };
      assert_ne!(id, UNKNOWN_COMMAND_ID, "{name:?} is unknown to this CEF build");
    }
  }

  // GitBolt patch, deferred minor #15 / fix round 1, item 6: `remove_recursive`,
  // `remove_empty_submenus` and `remove_redundant_separators` are generic over `MenuModelLike`
  // precisely so they can be tested here, against this in-memory fake, instead of a real
  // `MenuModel` — `menu_model_create` returns `None` outside a running browser process
  // (confirmed with a scratch test), so there is no way to populate one in a unit test.
  #[derive(Clone)]
  enum FakeItem {
    Command(c_int),
    Separator,
    Submenu(FakeMenu),
  }

  /// `Rc<RefCell<_>>`: CEF's own `get_sub_menu_at` hands back a live view of the same submenu,
  /// not a copy, so a removal inside it (found through a fresh `child_menu_at` call) is visible
  /// to every other handle. `MenuModelLike`'s methods take `&self`, matching the real
  /// `MenuModel`'s (CEF mutates through the FFI pointer, not through Rust's `&mut`).
  #[derive(Clone, Default)]
  struct FakeMenu(std::rc::Rc<std::cell::RefCell<Vec<FakeItem>>>);

  impl FakeMenu {
    fn new(items: Vec<FakeItem>) -> Self {
      FakeMenu(std::rc::Rc::new(std::cell::RefCell::new(items)))
    }
    fn commands(&self) -> Vec<Option<c_int>> {
      self.0.borrow().iter().map(|i| match i {
        FakeItem::Command(id) => Some(*id),
        _ => None,
      }).collect()
    }
    /// An owned handle to the submenu at `index` (never a borrow into `self.0`, so the caller
    /// can freely mutate `self` afterwards through it — as CEF's own `get_sub_menu_at` allows).
    fn submenu_at(&self, index: usize) -> FakeMenu {
      self.child_menu_at(index).expect("a submenu at this index")
    }
  }

  impl MenuModelLike for FakeMenu {
    fn item_count(&self) -> usize {
      self.0.borrow().len()
    }
    fn is_separator_at(&self, index: usize) -> bool {
      matches!(self.0.borrow()[index], FakeItem::Separator)
    }
    fn is_submenu_at(&self, index: usize) -> bool {
      matches!(self.0.borrow()[index], FakeItem::Submenu(_))
    }
    fn child_menu_at(&self, index: usize) -> Option<Self> {
      match &self.0.borrow()[index] {
        FakeItem::Submenu(m) => Some(m.clone()),
        _ => None,
      }
    }
    fn remove_command(&self, command_id: c_int) -> bool {
      let mut items = self.0.borrow_mut();
      let Some(pos) = items.iter().position(|i| matches!(i, FakeItem::Command(id) if *id == command_id)) else {
        return false;
      };
      items.remove(pos);
      true
    }
    fn remove_item_at(&self, index: usize) -> bool {
      let mut items = self.0.borrow_mut();
      if index >= items.len() {
        return false;
      }
      items.remove(index);
      true
    }
  }

  /// The exact shape minor #15 described: an id nested one level down, under a submenu with
  /// other, unrelated real entries either side of it.
  fn passwords_menu() -> FakeMenu {
    FakeMenu::new(vec![
      FakeItem::Command(1), // Copy
      FakeItem::Submenu(FakeMenu::new(vec![
        FakeItem::Command(10), // an unrelated password item, kept
        FakeItem::Command(20), // IDC_..._SELECT_PASSWORD, targeted
        FakeItem::Command(21), // IDC_..._SUGGEST_PASSWORD, targeted
      ])),
      FakeItem::Command(2), // Paste
    ])
  }

  #[test]
  fn remove_recursive_reaches_into_a_submenu_a_plain_remove_cannot_see() {
    let top = passwords_menu();
    let sub = top.submenu_at(1);

    // A plain, non-recursive remove at the top level can't see it: this is the bug (minor #15).
    assert!(!top.remove_command(20));
    assert_eq!(sub.commands(), vec![Some(10), Some(20), Some(21)]);

    assert!(remove_recursive(&top, 20));
    assert_eq!(sub.commands(), vec![Some(10), Some(21)], "only the targeted id goes");
    assert_eq!(top.commands(), vec![Some(1), None, Some(2)], "the submenu stays: a real entry is still in it");

    // A command nowhere in the tree: no-op, not a panic.
    assert!(!remove_recursive(&top, 999));
  }

  #[test]
  fn remove_empty_submenus_drops_a_parent_left_with_only_separators_where_its_items_were() {
    let top = FakeMenu::new(vec![
      FakeItem::Command(1), // Copy
      FakeItem::Submenu(FakeMenu::new(vec![
        FakeItem::Separator,
        FakeItem::Command(20),
        FakeItem::Separator,
        FakeItem::Command(21),
      ])),
      FakeItem::Command(2), // Paste
    ]);
    assert!(remove_recursive(&top, 20));
    assert!(remove_recursive(&top, 21));
    // Every real entry in the submenu is gone, but it's not yet "empty" by a raw count: two
    // separators are still in it (this is item 6: `remove_empty_submenus` must sweep those with
    // `remove_redundant_separators` before deciding).
    let sub = top.submenu_at(1);
    assert_eq!(sub.item_count(), 2);

    remove_empty_submenus(&top);
    assert_eq!(top.commands(), vec![Some(1), Some(2)], "the now-empty submenu container is gone");
  }

  #[test]
  fn remove_empty_submenus_keeps_a_submenu_with_a_real_entry_left() {
    let top = passwords_menu();
    assert!(remove_recursive(&top, 20));
    assert!(remove_recursive(&top, 21));
    remove_empty_submenus(&top);
    // Entry 10 is still real: the submenu (and its container item) stays.
    assert_eq!(top.item_count(), 3);
    let sub = top.submenu_at(1);
    assert_eq!(sub.commands(), vec![Some(10)]);
  }

  #[test]
  fn remove_redundant_separators_drops_leading_trailing_and_doubled_ones_only() {
    let m = FakeMenu::new(vec![
      FakeItem::Separator,
      FakeItem::Separator,
      FakeItem::Command(1),
      FakeItem::Separator,
      FakeItem::Separator,
      FakeItem::Command(2),
      FakeItem::Separator,
    ]);
    remove_redundant_separators(&m);
    assert_eq!(m.0.borrow().len(), 3);
    assert_eq!(m.commands(), vec![Some(1), None, Some(2)]);
  }
}
