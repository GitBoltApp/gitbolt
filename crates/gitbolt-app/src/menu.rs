//! The macOS menu bar: the app menu, Edit, Window and Help. A Mac app has one, and a webview on
//! macOS needs the Edit menu for Cmd+C / V / X / A / Z to edit text (AppKit sends `copy:` and
//! friends from the menu's key equivalents). Elsewhere the window has no menu bar.
//!
//! The items that are the app's own run its actions in the UI: an event with the action's id
//! (`MENU_EVENT`, `ui/src/app/nativeMenu.ts`), the same `runAction` the shortcuts and the palette
//! take. The rest are AppKit's own items. The structure is data (`MENU_BAR`), tested on every
//! platform; only building the native menu is macOS's.

/// The event the UI listens for; its payload is an app action's id. Must match `MENU_EVENT` in
/// `ui/src/app/nativeMenu.ts`.
#[cfg(any(target_os = "macos", test))]
pub const MENU_EVENT: &str = "gb:menu";

/// An item of the menu bar.
#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Item {
    /// Runs the UI's action `id` (`ui/src/app/actions.ts`). `accelerator` is muda's syntax, and
    /// is the same chord as the action's own shortcut, so the key does the same either way.
    Action { id: &'static str, label: &'static str, accelerator: Option<&'static str> },
    /// One of AppKit's own (`undo:`, `copy:`, `hide:`, `performMiniaturize:`, …).
    Native(Native),
    Separator,
}

#[cfg(any(target_os = "macos", test))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Native {
    Services,
    Hide,
    HideOthers,
    ShowAll,
    Undo,
    Redo,
    Cut,
    Copy,
    Paste,
    SelectAll,
    Minimize,
    Zoom,
}

/// A menu of the bar. `id`: Tauri's id for the Window or Help menu, which AppKit then manages
/// (the window list, the Help search field).
#[cfg(any(target_os = "macos", test))]
pub struct Menu {
    pub id: Option<&'static str>,
    pub title: &'static str,
    pub items: &'static [Item],
}

#[cfg(any(target_os = "macos", test))]
const fn action(id: &'static str, label: &'static str, accelerator: Option<&'static str>) -> Item {
    Item::Action { id, label, accelerator }
}

#[cfg(any(target_os = "macos", test))]
pub const MENU_BAR: &[Menu] = &[
    Menu {
        id: None,
        title: "GitBolt",
        items: &[
            action("help.about", "About GitBolt", None),
            Item::Separator,
            action("file.settings", "Settings…", Some("Cmd+,")),
            action("help.checkUpdates", "Check for Updates…", None),
            Item::Separator,
            Item::Native(Native::Services),
            Item::Separator,
            Item::Native(Native::Hide),
            Item::Native(Native::HideOthers),
            Item::Native(Native::ShowAll),
            Item::Separator,
            // The UI's Quit, not AppKit's `terminate:`: it saves the profile first (`file.quit`).
            action("file.quit", "Quit GitBolt", Some("Cmd+Q")),
        ],
    },
    Menu {
        id: None,
        title: "Edit",
        items: &[
            Item::Native(Native::Undo),
            Item::Native(Native::Redo),
            Item::Separator,
            Item::Native(Native::Cut),
            Item::Native(Native::Copy),
            Item::Native(Native::Paste),
            Item::Native(Native::SelectAll),
        ],
    },
    Menu { id: Some(tauri::menu::WINDOW_SUBMENU_ID), title: "Window", items: &[Item::Native(Native::Minimize), Item::Native(Native::Zoom)] },
    Menu { id: Some(tauri::menu::HELP_SUBMENU_ID), title: "Help", items: &[action("help.shortcuts", "Keyboard Shortcuts", Some("Cmd+/"))] },
];

/// The action a menu event asks for: an `Item::Action`'s id, `None` for any other item.
#[cfg(any(target_os = "macos", test))]
pub fn action_of(menu_id: &str) -> Option<&'static str> {
    MENU_BAR.iter().flat_map(|m| m.items).find_map(|i| match i {
        Item::Action { id, .. } if *id == menu_id => Some(*id),
        _ => None,
    })
}

/// Gives the app its menu bar on macOS; elsewhere `builder` is unchanged.
pub fn attach<R: tauri::Runtime>(builder: tauri::Builder<R>) -> tauri::Builder<R> {
    #[cfg(target_os = "macos")]
    {
        use tauri::Emitter;
        builder.menu(native::build).on_menu_event(|app, event| {
            if let Some(id) = action_of(event.id().as_ref())
                && let Err(e) = app.emit(MENU_EVENT, id)
            {
                tracing::warn!("menu item {id}: emit {MENU_EVENT} failed: {e}");
            }
        })
    }
    #[cfg(not(target_os = "macos"))]
    builder
}

#[cfg(target_os = "macos")]
mod native {
    use super::{Item, Native, MENU_BAR};
    use tauri::menu::{IsMenuItem, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::{AppHandle, Runtime};

    pub fn build<R: Runtime>(app: &AppHandle<R>) -> tauri::Result<tauri::menu::Menu<R>> {
        let bar = tauri::menu::Menu::new(app)?;
        for m in MENU_BAR {
            let menu = match m.id {
                Some(id) => Submenu::with_id(app, id, m.title, true)?,
                None => Submenu::new(app, m.title, true)?,
            };
            for item in m.items {
                let built: Box<dyn IsMenuItem<R>> = match *item {
                    Item::Action { id, label, accelerator } => Box::new(MenuItem::with_id(app, id, label, true, accelerator)?),
                    Item::Separator => Box::new(PredefinedMenuItem::separator(app)?),
                    Item::Native(n) => Box::new(native(app, n)?),
                };
                menu.append(built.as_ref())?;
            }
            bar.append(&menu)?;
        }
        Ok(bar)
    }

    fn native<R: Runtime>(app: &AppHandle<R>, n: Native) -> tauri::Result<PredefinedMenuItem<R>> {
        match n {
            Native::Services => PredefinedMenuItem::services(app, None),
            Native::Hide => PredefinedMenuItem::hide(app, Some("Hide GitBolt")),
            Native::HideOthers => PredefinedMenuItem::hide_others(app, None),
            Native::ShowAll => PredefinedMenuItem::show_all(app, None),
            Native::Undo => PredefinedMenuItem::undo(app, None),
            Native::Redo => PredefinedMenuItem::redo(app, None),
            Native::Cut => PredefinedMenuItem::cut(app, None),
            Native::Copy => PredefinedMenuItem::copy(app, None),
            Native::Paste => PredefinedMenuItem::paste(app, None),
            Native::SelectAll => PredefinedMenuItem::select_all(app, None),
            Native::Minimize => PredefinedMenuItem::minimize(app, None),
            // AppKit's Zoom (`performZoom:`): Tauri's "maximize" item.
            Native::Zoom => PredefinedMenuItem::maximize(app, Some("Zoom")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn titles() -> Vec<&'static str> {
        MENU_BAR.iter().map(|m| m.title).collect()
    }

    #[test]
    fn the_bar_is_the_app_menu_then_edit_window_and_help() {
        assert_eq!(titles(), ["GitBolt", "Edit", "Window", "Help"]);
        // Tauri's ids: AppKit then manages the Window menu (the window list) and Help (its search).
        assert_eq!(MENU_BAR[2].id, Some(tauri::menu::WINDOW_SUBMENU_ID));
        assert_eq!(MENU_BAR[3].id, Some(tauri::menu::HELP_SUBMENU_ID));
    }

    #[test]
    fn the_app_menu_runs_the_apps_own_actions() {
        let app = MENU_BAR[0].items;
        let actions: Vec<_> = app
            .iter()
            .filter_map(|i| match i {
                Item::Action { id, label, accelerator } => Some((*id, *label, *accelerator)),
                _ => None,
            })
            .collect();
        assert_eq!(
            actions,
            [
                ("help.about", "About GitBolt", None),
                ("file.settings", "Settings…", Some("Cmd+,")),
                ("help.checkUpdates", "Check for Updates…", None),
                ("file.quit", "Quit GitBolt", Some("Cmd+Q")),
            ]
        );
        for n in [Native::Services, Native::Hide, Native::HideOthers, Native::ShowAll] {
            assert!(app.contains(&Item::Native(n)), "{n:?}");
        }
        assert_eq!(app.last(), Some(&action("file.quit", "Quit GitBolt", Some("Cmd+Q"))), "Quit comes last");
    }

    #[test]
    fn edit_has_the_text_editing_items_a_webview_needs() {
        use Native::*;
        let natives: Vec<_> = MENU_BAR[1].items.iter().filter_map(|i| if let Item::Native(n) = i { Some(*n) } else { None }).collect();
        assert_eq!(natives, [Undo, Redo, Cut, Copy, Paste, SelectAll]);
        assert_eq!(MENU_BAR[2].items, [Item::Native(Minimize), Item::Native(Zoom)]);
        assert_eq!(MENU_BAR[3].items, [action("help.shortcuts", "Keyboard Shortcuts", Some("Cmd+/"))]);
    }

    #[test]
    fn the_event_is_the_one_the_ui_listens_for() {
        let ui = include_str!("../../../ui/src/app/nativeMenu.ts");
        assert!(ui.contains(&format!("export const MENU_EVENT = '{MENU_EVENT}';")), "MENU_EVENT differs from ui/src/app/nativeMenu.ts");
    }

    #[test]
    fn a_menu_event_names_the_action_or_nothing() {
        assert_eq!(action_of("file.settings"), Some("file.settings"));
        assert_eq!(action_of("help.shortcuts"), Some("help.shortcuts"));
        assert_eq!(action_of("edit.palette"), None);
        assert_eq!(action_of(""), None);
    }

    #[test]
    fn action_ids_are_unique_and_accelerators_use_cmd() {
        let mut ids = std::collections::HashSet::new();
        for i in MENU_BAR.iter().flat_map(|m| m.items) {
            if let Item::Action { id, accelerator, .. } = i {
                assert!(ids.insert(*id), "{id} twice");
                if let Some(a) = accelerator {
                    assert!(a.starts_with("Cmd+"), "{id}: {a}");
                }
            }
        }
    }
}
