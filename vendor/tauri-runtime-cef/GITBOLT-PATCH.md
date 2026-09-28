# GitBolt patch: tauri-runtime-cef 3.0.0-alpha.4

Vendored from the upstream crate `tauri-runtime-cef` 3.0.0-alpha.4 (published crate contents,
copied from the GitBolt CEF spike's `spike-cef/vendor/tauri-runtime-cef/`; upstream source is
`crates/tauri-runtime-cef` in `tauri-apps/tauri` at git commit `d05973d48957343599889030400ec1a79e7d0363`,
see `.cargo_vcs_info.json`). License unchanged: `Apache-2.0 OR MIT`.

Pulled in via `[patch.crates-io]` in the workspace root `Cargo.toml`, pinned to the same
`=3.0.0-alpha.4` version as the crates.io release so the patch is a drop-in replacement.

## Workaround: CEF issue #3002 (Linux idle busy loop)

**Upstream bug:** [chromiumembedded/cef#3002](https://github.com/chromiumembedded/cef/issues/3002)
("Linux: 100% CPU when using external-message-pump"). On Linux, `tauri-runtime-cef`'s
`external_message_pump: 1` setting makes CEF's browser-process UI pump
`MessagePumpExternal`, a subclass of Chromium's `base::MessagePumpGlib`. That base class
attaches a "work source" `GSource` to the default GLib context in its constructor, but
`MessagePumpExternal::Run` replaces `MessagePumpGlib::Run` without ever setting `state_`, so
the work source's prepare callback takes CEF's `if (!state_) return 0;` branch on every GLib
iteration: a zero poll timeout, forever. `tauri-winit-gtk4`'s event loop blocks in
`g_main_context_iteration(TRUE)` on that same context, so this turns every idle "blocking" wait
into a busy loop — 100% of one CPU core, with the browser process's main thread spinning
`ppoll(..., 0)` 3,500-5,600 times/second, even on `about:blank`.

**Fix:** destroy that GLib work source once `cef::initialize` returns. It does nothing useful
under `external_message_pump` — its check callback also bails out on a null `state_`, and
`MessagePumpExternal` overrides `ScheduleWork`/`ScheduleDelayedWork` to bypass it entirely — so
the runtime's own cefclient-style pump source (already present) stays in charge, exactly as
intended. The source is found structurally (its prepare callback resolves into `libcef.so` via
`dladdr`, it polls exactly one fd that is a pipe, it is recursive, and calling its prepare once
returns "not ready, zero timeout"), so the workaround becomes a safe no-op if CEF/Chromium ever
fixes `MessagePumpGlib::HandlePrepare` upstream.

Full write-up, reproduction, and measured before/after idle numbers (100.4-100.6% -> 0.72-1.00%
across all processes, fling/scroll fps and `invoke()` latency unaffected): see
`docs/upstream/cef-3002-tauri-runtime-cef.md` (a committed copy of the draft originally written
in the CEF spike, `spike-cef/UPSTREAM_ISSUE.md` on the `spike/webkitgtk` worktree branch — linking
a copy here instead of that worktree path, since it isn't guaranteed to exist in every checkout)
and `docs/decisions/cef-over-webkitgtk.md` ("Idle CPU"). A version of
this report was posted as a comment on the upstream issue:
[chromiumembedded/cef#3002 (comment)](https://github.com/chromiumembedded/cef/issues/3002#issuecomment-5852697736).
Filing it against `tauri-apps/tauri` directly is still the user's call.

**Task 14's own measurements** — see `docs/upstream/cef-3002-tauri-runtime-cef.md`'s closing note:
an idle, no-repo-open control reproduces the spike's near-zero result (0.700% over 30 s), and a
settled 60 s sample with a large repository open measured 0.617%, both consistent with the spike's
own 0.72–1.00%. One 60 s sample taken while other desktop apps were actively running (Firefox,
GNOME Shell, another desktop git client, a live `git` fetch) measured 13.517%, concentrated in GitBolt's own browser and
renderer processes — real on-CPU work by those processes during a period of genuinely higher
desktop activity (`/proc/<pid>/stat`'s `utime+stime` can't be inflated by other processes'
scheduling). The user reviewed these numbers and accepted them for the CEF runtime on 2026-09-27,
noting their laptop is thermally capped at 70°C so per-run CPU throughput isn't perfectly
consistent.

## Chrome accelerators left live upstream (F7 caret browsing and the rest)

**Problem:** GitBolt runs Chrome style (CEF's default on Linux), and a Chrome style browser keeps
its whole accelerator table live even as a hosted child view. Upstream blocks many of those
commands in `CefCommandHandler::OnChromeCommand` (`src/cef_impl/client/command.rs`), but not F7
(`IDC_CARET_BROWSING_TOGGLE`): an F7 the page didn't handle opened Chrome's "Turn on caret
browsing?" tab-modal dialog, and its modal overlay then dimmed the window for good. F6/Shift+F6
focus cycling, the find bar (Ctrl+F, F3, Ctrl+G), Esc→stop, Ctrl+Shift+M's avatar bubble,
Ctrl+W / Ctrl+Shift+W / Ctrl+Shift+Q and reload were live too.

**Fix:** a GitBolt block list, consulted by the existing `blocks()` for the app's own browser
only (`owns()`: a DevTools window keeps its accelerators). It's data only, in the same
name-resolved form as upstream's tables (a name a later CEF drops resolves to -1 and is skipped).
None of these keys is reserved except the close/exit ones, so the page still gets the keydown
first; only a key the page leaves unhandled is swallowed. `gitbolt-app` also sets the profile
preference `settings.a11y.caretbrowsing.enabled=false` as a backstop.

**Reserved chords reach the page** (`src/cef_impl/client/keyboard.rs`): Ctrl+W, Ctrl+F4,
Ctrl+Tab, Ctrl+Shift+Tab, Ctrl+PgUp, Ctrl+PgDn and Ctrl+Shift+T are Chrome *reserved* keys,
which Chrome runs before the page sees them, so blocking their command alone left them dead.
GitBolt binds them: Ctrl+W closes the open file today (and a tab in plan 1C), and plan 1C binds
the tab-switching ones and Ctrl+Shift+T. `on_pre_key_event` now answers them with
`*is_keyboard_shortcut = 1; return 0` (the documented `OnPreKeyEvent` contract, research doc
§2.3): CEF skips the reserved-key pre-processing and sends the event to the renderer; one the
page leaves unhandled reaches the accelerator, whose command the tables above block. Exactly
those chords: no Shift except on Tab and T, so Ctrl+Shift+W (close window) and Ctrl+Shift+PgUp /
PgDn (move tab) keep Chrome's handling. And only for the app's own browser, identified as
`command.rs`'s `owns()` does (the frame navigation state's browser id): a DevTools window or a
CEF-owned popup is a real Chrome window and keeps Chrome's reserved-key protection.

**Key diagnostic, debug builds only:** `GITBOLT_KEY_LOG` is honoured only when
`cfg!(debug_assertions)`, so a release build never logs keystrokes whatever the environment
says.

## Exact files changed vs. the unpatched 3.0.0-alpha.4 crate

- `src/external_message_pump/linux.rs`: added two functions —
  `next_default_context_source_id()` (returns the GLib source id the default context will hand
  out next, used as a fence) and `neutralize_chromium_glib_work_source(since_id)` (scans sources
  attached since that fence, identifies Chromium's `MessagePumpGlib` work source by the
  structural checks above, and calls `g_source_destroy` on it). Everything else in this file
  (the runtime's own pump `GSource`, wakeup pipe, timer bookkeeping) is unmodified upstream code.
- `src/external_message_pump/mod.rs`: added a `pub(crate) use` re-export of both functions above
  from the `linux` submodule (`pub(crate) use linux::{neutralize_chromium_glib_work_source,
  next_default_context_source_id};`), so `runtime.rs` can call them. No other change in this file.
- `src/runtime.rs`: two call sites added around the Linux/BSD `cef::initialize` call —
  `glib_source_id_before_cef` is captured immediately before `cef::initialize`, and
  `neutralize_chromium_glib_work_source(glib_source_id_before_cef)` is called once the CEF
  context has finished initializing (logs a warning via `log::warn!` if it destroys nothing, so a
  future CEF release that fixes #3002 upstream is visible rather than silently changing
  behaviour). A third, optional diagnostic: if the `GITBOLT_PUMP_LOG` environment variable is
  set, the same call site also `eprintln!`s how many sources were destroyed — visible even when
  the application has no logger installed (or filters this crate's logs out). It runs in the
  browser process only: helper processes return from `cef_entry_point` before reaching this
  code. Off by default; never read by `gitbolt-app` itself.

- `src/cef_impl/client/command.rs` (Chrome accelerators, above): added
  `GITBOLT_BLOCKED_COMMANDS` (always blocked: `IDC_CARET_BROWSING_TOGGLE`,
  `IDC_FOCUS_NEXT_PANE`, `IDC_FOCUS_PREVIOUS_PANE`, `IDC_FOCUS_WEB_CONTENTS_PANE`,
  `IDC_FOCUS_INACTIVE_POPUP_FOR_ACCESSIBILITY`, `IDC_FIND`, `IDC_FIND_NEXT`, `IDC_FIND_PREVIOUS`,
  `IDC_CLOSE_FIND_OR_STOP`, `IDC_STOP`, `IDC_SHOW_AVATAR_MENU`, `IDC_QRCODE_GENERATOR`,
  `IDC_SHOW_TRANSLATE`, `IDC_SHOW_READING_MODE_SIDE_PANEL`, `IDC_CLOSE_TAB`, `IDC_CLOSE_WINDOW`,
  `IDC_EXIT`) and `GITBOLT_RELEASE_BLOCKED_COMMANDS` (release builds only: `IDC_RELOAD`,
  `IDC_RELOAD_BYPASSING_CACHE`, `IDC_RELOAD_CLEARING_CACHE`); `gitbolt_blocked_names(release)`;
  a `gitbolt` field in `BlockedCommands`, filled for the build profile (`cfg!(debug_assertions)`);
  one more `||` arm in `blocks()`; and unit tests (`cargo test -p tauri-runtime-cef --lib command`).
  Also an opt-in diagnostic, debug builds only (`key_log_allowed()` is `cfg!(debug_assertions)`):
  with `GITBOLT_KEY_LOG` set, `on_chrome_command` prints each command the app's browser gets
  (id, IDC name when known, blocked or runs) to stderr (`gitbolt_key_log()`, `command_name()`).
  Tests also check that every GitBolt name resolves to a command id in this CEF build.
- `src/cef_impl/client/keyboard.rs`: the same diagnostic at the top of `on_pre_key_event` (key
  event type, `windows_key_code`, modifiers); and `gitbolt_passes_to_page(owned, …)` with its
  call at the top of `on_pre_key_event`, ahead of (and independent of) the devtools block: the
  reserved chords above get `is_keyboard_shortcut = 1` and return 0, for the app's own browser
  only. `TauriCefKeyboardHandler` gains a `frame_navigation_state` field for that, passed in by
  `src/cef_impl/client/mod.rs`'s `keyboard_handler()` (the one change in that file). Unit tests
  for the chord table, the Shift rules and the ownership scoping.
- `src/cef_impl/client/context_menu.rs` (context menu, below): more IDC names in
  `BROWSER_ONLY_COMMANDS`, and the file's first unit tests.

## Context menu entries that make no sense in an app window

**Problem:** right-clicking selected text offered "Copy link to highlight", which copies a
`http://tauri.localhost/#:~:text=…` text-fragment URL, plus Chrome's AI, reading and sharing
services and password/address autofill.

**Fix:** data only. `BROWSER_ONLY_COMMANDS` also drops `IDC_CONTENT_CONTEXT_COPYLINKTOTEXT`,
`…_RESHARELINKTOTEXT`, `…_REMOVELINKTOTEXT`; the Glic, "Listen to this page", "Save to memory
banks", quick-answers, send-to-device and image-description (accessibility labels) entries; the
password, passkey and autofill-fallback entries; protocol-handler settings; and "Copy image
address" (a `blob:` URL; Copy image stays). Upstream's own list already drops web search,
print, Lens, translate, back/forward/reload, save and view source; Inspect goes with devtools,
which release builds disable. Tests: `cargo test -p tauri-runtime-cef --lib context_menu`
(the dropped names, the kept editing entries, every name resolves in this CEF build).

No other files differ from the published 3.0.0-alpha.4 crate.
