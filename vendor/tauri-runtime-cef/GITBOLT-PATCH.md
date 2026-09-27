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

No other files differ from the published 3.0.0-alpha.4 crate.
