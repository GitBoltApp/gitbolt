# Upstream report: tauri-runtime-cef idle busy loop (CEF #3002)

Committed copy of the draft originally written in the GitBolt CEF spike
(`spike-cef/UPSTREAM_ISSUE.md`, on the `spike/webkitgtk` worktree branch), kept here so
`vendor/tauri-runtime-cef/GITBOLT-PATCH.md` doesn't link to a worktree that may not exist in every
checkout. This is the fix vendored in `vendor/tauri-runtime-cef` (see `GITBOLT-PATCH.md` for the
exact files changed).

A version of this report was posted as a comment on the upstream issue:
[chromiumembedded/cef#3002 (comment)](https://github.com/chromiumembedded/cef/issues/3002#issuecomment-5852697736).
Filing it against `tauri-apps/tauri` directly (the `crates/tauri-runtime-cef` crate, target of the
draft below) is still the user's call — not yet done.

---

Target: `tauri-apps/tauri` (the `crates/tauri-runtime-cef` crate). Related upstream CEF bug:
chromiumembedded/cef#3002 (open, "help wanted"); earlier report chromiumembedded/cef#2809.

---

**Title:** [bug] tauri-runtime-cef (Linux): main thread busy-loops at 100% of a core when idle (CEF external message pump + GLib, CEF #3002)

**Body:**

### Describe the bug

On Linux, any app on `tauri-runtime-cef` 3.0.0-alpha.4 uses 100% of one CPU core while it is
completely idle. This happens on every page, `about:blank` included. All of it is in the browser
process's main (UI) thread. Renderer, GPU and utility processes stay idle.

The thread never blocks. `strace` shows about 3,500 to 5,600 `ppoll` calls per second, all with a
**zero timeout**. Each one is followed by `recvmsg` returning `EAGAIN` on the X11 sockets.

### Reproduction

1. Build this minimal app in release mode, then run it on Linux (X11 or XWayland; the runtime
   forces X11 either way):

   ```rust
   use tauri::{WebviewUrl, WebviewWindowBuilder};
   use tauri_runtime_cef::Cef;

   #[tauri_runtime_cef::cef_entry_point]
   fn main() {
     tauri::Builder::default()
       .runtime(Cef::default())
       .setup(|app| {
         WebviewWindowBuilder::new(app.handle(), "main", WebviewUrl::External("about:blank".parse().unwrap()))
           .build()?;
         Ok(())
       })
       .run(tauri::generate_context!())
       .unwrap();
   }
   ```

2. Leave the window alone for 15 seconds, then sample the browser process's threads:
   `for t in /proc/<pid>/task/*; do awk '{print $14+$15}' $t/stat; done`. Sample twice, 10 s
   apart. The main thread gains about 1,000 ticks in 10 s at `CLK_TCK=100`, which is one full core.

Environment: Ubuntu 26.04, kernel 7.0, GNOME 50 (Wayland session, XWayland), GTK 4.22.4, GLib from
the distro. `tauri` 3.0.0-alpha.3, `tauri-runtime-cef` 3.0.0-alpha.4, `tauri-winit-gtk4`
0.31.0-beta.3, `cef` 152.3.0+152.0.6 (Chromium 152.0.7977.83). Release builds, remote debugging
disabled. It happens with Chromium's sandbox both on and off.

### Root cause

This is chromiumembedded/cef#3002, reached through the runtime's Linux event loop:

- `tauri-runtime-cef` sets `external_message_pump: 1` (`src/runtime.rs:3291`). CEF's browser UI
  pump is then `MessagePumpExternal` (CEF `libcef/browser/browser_message_loop.cc:23`,
  `class MessagePumpExternal : public base::MessagePumpForUI`). On Linux that base class is
  `base::MessagePumpGlib`.
- The `MessagePumpGlib` constructor attaches a "work source" to `g_main_context_default()`
  (Chromium `base/message_loop/message_pump_glib.cc:460,494`).
- `MessagePumpExternal::Run` (`browser_message_loop.cc:29`) replaces `MessagePumpGlib::Run`
  (`message_pump_glib.cc:741`), and that `Run` is the only place `state_` is set
  (`message_pump_glib.cc:745`). So `state_` stays null for the pump's whole life.
- The work source's prepare callback returns `HandlePrepare()`, which starts with
  `if (!state_) { return 0; }` (`message_pump_glib.cc:663-665`). The result is a **zero poll
  timeout on every GLib iteration, forever**. Its check also returns FALSE on a null `state_`
  (`:682`), so it never dispatches. It only stops GLib from sleeping.
- `tauri-winit-gtk4`'s loop is correct. With the default `ControlFlow::Wait` it blocks in
  `g_main_context_iteration(TRUE)` (`src/event_loop.rs:331-332`). On that same default context,
  though, the call returns immediately after a `ppoll(..., 0)`, and the loop spins.

Evidence that this is the mechanism and nothing else:

- `perf record -g` of the main thread: 98% of samples are under `g_main_context_iteration`. They
  are spent in the prepare/check callbacks and syscalls (`XSourcePrepare`/`XSourceCheck` →
  `x11::Connection::HasPendingResponses` → `recvmsg`; GDK's `XPending`), with
  `base::(anonymous namespace)::WorkSourceCheck` and `ObserverPrepare` on the stack.
  `MessagePumpExternal::Run` (the actual CEF work) accounts for 0.24%.
- Disassembly of the shipped `libcef.so`, which has debug info: `WorkSourcePrepare` loads
  `pump->state_` and, when it is null, stores 0 into `*timeout_ms`
  (`message_pump_glib.cc:663` → `:340`). `~MessagePumpExternal` ends by calling
  `base::MessagePumpGlib::~MessagePumpGlib()`.
- Destroying just that one `GSource` stops the spin completely. Nothing else changes, first with an
  `LD_PRELOAD` shim, then with the patch below.

### Proposed fix (workaround in tauri-runtime-cef until CEF fixes #3002)

In external-pump mode, Chromium's glib work source does no useful work: its check bails out on a
null `state_`, and `MessagePumpExternal` overrides `ScheduleWork`/`ScheduleDelayedWork`, so its
wakeup pipe is never written. The fix is to destroy it once `cef::initialize` returns. That leaves
the runtime's own cefclient-style pump source in charge, as intended.

Chromium's symbols are not exported, so the source is identified structurally among the sources
attached to the default context during `cef::initialize`:

- its prepare callback lives in `libcef.so` (`dladdr`);
- it polls exactly one fd, and that fd is a pipe;
- it is recursive;
- calling its prepare once returns FALSE with timeout 0.

The last check makes the workaround a no-op if CEF/Chromium ever fixes `HandlePrepare`. After
`cef::initialize` that is exactly one source. `MessagePumpGlib`'s destructor later calls
`g_source_destroy` + `g_source_unref`, and destroying an already-destroyed source is a no-op.

Patch against 3.0.0-alpha.4 (condensed; the full diff is in the GitBolt spike's
`evidence/tauri-runtime-cef-3002.patch`, and applied in this repo's
`vendor/tauri-runtime-cef` — see `GITBOLT-PATCH.md`):

```rust
// external_message_pump/linux.rs
pub(crate) fn next_default_context_source_id() -> c_uint { /* attach+destroy a probe idle source, return id + 1 */ }

pub(crate) fn neutralize_chromium_glib_work_source(since_id: c_uint) -> usize {
  // for id in since_id..next_default_context_source_id():
  //   source = g_main_context_find_source_by_id(default, id), skip destroyed
  //   require: dladdr(source_funcs->prepare) in "libcef.so"; exactly one GPollFD and it's a FIFO;
  //            g_source_get_can_recurse(source); prepare(source, &t) == FALSE && t == 0
  //   => g_source_destroy(source)
}

// runtime.rs, Linux/BSD only
let glib_source_id_before_cef = crate::external_message_pump::next_default_context_source_id();
cef::initialize(...);
// ... after the context-initialized wait:
if crate::external_message_pump::neutralize_chromium_glib_work_source(glib_source_id_before_cef) == 0 {
  log::warn!("Chromium's MessagePumpGlib work source was not found; ... CEF issue #3002");
}
```

Results on the machine above (`about:blank`-like page; every process of the app, 60 s; all runs
use the same window and display):

| | idle CPU (all processes) | main thread, 10 s | zero-timeout `ppoll`/s |
|---|---|---|---|
| unpatched | 100.4–100.6% | 1,010 ticks | 3,544–5,649 |
| patched | 0.72–1.00% | 4–5 ticks | ~30 (the pump's 33 ms timer) |

Fling and scroll fps were unchanged: 65.3–65.6 fps patched vs 64.6–65.8 unpatched on a 2,000-row
canvas fling. The `invoke()` round trip was unchanged too (median 2.2 vs 2.1 ms over 30 calls).

What's left at idle comes from the cefclient-style pump's 30 Hz safety-net timer
(`K_MAX_TIMER_DELAY`). Raising that cap to 1 s made idle *worse* and added jank, so it is still
needed.

A proper fix belongs in CEF. `MessagePumpExternal` should not attach `MessagePumpGlib`'s work
source (or should derive from a non-glib pump), or `HandlePrepare` should return -1 when `state_`
is null. The workaround above is safe to keep in the meantime.

### Note on Task 14's own measurements (GitBolt `gitbolt-app`, not the spike)

The workaround demonstrably still works in `gitbolt-app`: an idle, no-repo-open control measured
0.700% over 30 s, a settled 60 s sample with a large repository open measured 0.617%, and the
"workaround not found" warning never fired in any launch's log — both figures consistent with the
spike's own 0.72–1.00%. One further 60 s sample, taken while other desktop apps were actively
running (Firefox, GNOME Shell, another desktop git client, a live `git` fetch), measured 13.517%, concentrated in GitBolt's
own browser and renderer processes. `/proc/<pid>/stat`'s `utime+stime` only counts a process's
own on-CPU time, so that's real work by GitBolt's processes during a period of genuinely higher
desktop activity, not scheduling contention inflating the count. The user reviewed these numbers
and accepted them for the CEF runtime on 2026-09-27 (their laptop is thermally capped at 70°C, so
per-run CPU throughput isn't perfectly consistent).
