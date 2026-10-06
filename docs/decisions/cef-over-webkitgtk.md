# CEF over WebKitGTK

**Decision:** GitBolt runs on Tauri's CEF runtime (`tauri-runtime-cef`, a Chromium build) instead
of Tauri's default Linux webview, WebKitGTK. WebKit can't run the Monaco diff editor smoothly, and
the cause is in the engine itself. CEF runs it at full frame rate with about 35× fewer janky
frames; its own problems were either fixable or had workarounds, and the costs below were
accepted.

This records a throwaway spike from September 2026. Its code and raw logs aren't part of this
repository; the numbers below are copied from them unchanged.

## The question

Is WebKitGTK fast enough for GitBolt's heaviest surfaces: a canvas commit graph over a
virtualized list, the Monaco diff editor with Shiki highlighting on a 5,000-line file, and 12 tabs
kept mounted with React `<Activity>`? If not, is Tauri's CEF runtime a usable alternative?

## What was tried

The same React frontend, with one bench page per route, was built twice: on Tauri 2 with
WebKitGTK, and on Tauri 3 alpha with `tauri-runtime-cef`. Each route ran in its own process, which
was killed afterwards. Benches:

- **graph-2000 / graph-10000:** a 10 s scroll fling over a 2,000- or 10,000-row graph.
- **diff-5k-php:** a 5,000-line PHP diff. Cold open, then scrolls at 80 px/frame and at a more
  realistic 16 px/frame, a warm open of a second file pair in the same editor, a variant with
  `automaticLayout: false`, and one with Monaco's built-in Monarch tokenizer instead of Shiki.
- **tabs-12:** switch time across 12 mounted tabs, and whether hidden tabs' effects stop.
- **zoom:** whether `devicePixelRatio` follows the webview zoom.
- **Idle CPU:** `measure-idle.sh 60`, summed over every process of the instance.
- **Memory:** `measure-mem.sh`, total PSS with 12 tabs open.
- **Engine comparison:** the same built page under headless Playwright Chromium and WebKit, outside
  Tauri, to separate the WebKit engine from WebKitGTK's Linux integration.
- **Functional checks on CEF:** IPC, window controls, drag regions, fullscreen, clipboard,
  keyboard shortcuts, drag and drop.

| | |
|---|---|
| Machine | AMD Ryzen 7 7840U laptop (16 threads, Radeon 780M iGPU), GNOME on Wayland, eDP-1 panel at 59.93 Hz |
| WebKitGTK | `webkit2gtk-4.1` 2.52.6; Tauri 2.12.0, wry 0.57.0 |
| CEF | `tauri` 3.0.0-alpha.3, `tauri-runtime-cef` 3.0.0-alpha.4 (GTK 4 backend); CEF 152.0.6, Chromium 152.0.7977.83 |
| Headless engines | Playwright 1.63.0; Chromium headless-shell 153.0.8010.12; WebKit 26.6 |
| Build | Release profile (lto, codegen-units=1, opt-level=3, strip) |

### Reading the numbers

- **"Janky"** means a frame over 20 ms.
- **CEF's frame clock isn't locked to the display.** Under XWayland Chromium runs rAF off a
  synthetic 60 Hz timer (exactly 16.5 ms intervals, even on a 120 Hz monitor), so CEF reports
  60–66 fps on a 59.93 Hz panel. Compare janky % and p99, not fps. Even a near-empty page shows
  2.7–3.7% janky frames on CEF: that is its floor on this machine, before any content.
- **`openMs` for `diff-5k-php` excludes `createDiffEditor()`**, except WebKit's first run
  (1047 ms) and both Monarch numbers, which include it.
- **A periodic system stall** (about 150–175 ms every 10 s, from garbage collection in
  gnome-shell, also seen in a plain GTK 4 window) affected some runs. The primary CEF numbers
  (series C) come from a clean session after a re-login; series A and B1 are in brackets, and B1
  probably ran inside the stall state. The WebKit runs had no stall check.

## Findings

### Side by side

All on eDP-1 at 59.93 Hz. fps / janky % / p99 ms.

| Check | Pass threshold | WebKitGTK 2.52.6 | CEF 152 | CEF verdict |
|---|---|---|---|---|
| graph-2000 | ≥ 55 fps, < 1% janky | 58.44–59.97 fps, 0–0.68%, p99 17–18 | **66.09 / 1.81% / 24.9** (A 64.64 / 1.55% / 23.5; B1 64.49 / 4.18% / 33.9) | fps PASS, janky FAIL (at CEF's floor) |
| graph-10000 | informational | 59.29 / 0.34% / 18 | 64.88 / 3.54% / 25.1 (A 65.00 / 2.62%; B1 64.26 / 2.80%) | informational |
| diff-5k-php cold open | < 400 ms | 693 ms (1047 ms incl. editor construction) | **321.9 ms** (A 285.7; B1 292.7) | **PASS** |
| diff scroll, 80 px/frame | ≥ 55 fps, < 2% janky | 36.76 / 99.18% / 43 (first run 27.67 / 99.28% / 56) | **66.53 / 2.71% / 33.1** (A 62.84 / 3.82%; B1 63.01 / 2.22%) | fps PASS, janky marginal FAIL; **~35× fewer janky frames** |
| diff scroll, 16 px/frame | same | 45.05 / 67.41% / 36 | 60.00 / **1.33%** / 24.9 (A 57.69 / 2.60%; B1 59.10 / 1.52%) | PASS in C and B1, FAIL in A |
| diff warm open | < 400 ms | 130 ms | 51.3 ms (A 58.4; B1 57.1) | PASS |
| diff, `automaticLayout: false` | informational | 305 ms; 35.56 / 99.44% / 37 | 160.3 ms; 60.10 / 1.00% / 18.9 (A 183 / 58.21 / 3.78%) | informational |
| diff, Monarch (open incl. construction) | informational | 620 ms; 41.23 / 94.17% / 32 | 383.7 ms; 64.34 / 3.11% / 25.1 (A 388.3 / 1.90%; B1 411.7 / 3.02%) | informational |
| Shiki highlighter init | < 800 ms | 123 / 83 ms | 106.1 ms (A 81.2; B1 85.3) | PASS |
| tabs-12 switch | every value < 50 ms | max 73 ms (first switch; the rest 28–46) | **max 23.5 ms** (A max 28.7) | **PASS** |
| tabs-12 hidden ticks | all 0 | all 0 | all 0 | PASS |
| 12-tab PSS | < 400 MB | 280 MB | **554 MB** (complete, unsandboxed) | **FAIL** |
| Idle CPU, 60 s | < 0.5% | 0.017–2.0% (one 15.18% outlier) | stock: 100.2–100.8%; **with the #3002 workaround: 0.72–1.00%** | stock FAIL; patched marginal FAIL |
| DPR follows zoom | yes | 1 / 1.5 / 2 | 1 / 1.5 / 2 | PASS |

### The diff editor: an engine problem

On WebKitGTK the diff editor fails its open budget by 1.7–2.6× and scrolls at 27–37 fps with ~99%
janky frames. Changing one factor at a time doesn't fix it:

| WebKitGTK variant | openMs | fps | janky % | p99 (ms) |
|---|---|---|---|---|
| Baseline (Shiki, `automaticLayout: true`, 80 px/frame) | 693 | 36.76 | 99.18 | 43 |
| Realistic scroll speed, 16 px/frame | n/a | 45.05 | 67.41 | 36 |
| Monarch tokenizer instead of Shiki | 620 (incl. construction) | 41.23 | 94.17 | 32 |
| `automaticLayout: false` | 305 | 35.56 | 99.44 | 37 |

Headless, with WebKitGTK, GTK, the Wayland compositor and the GPU driver all out of the picture,
the same page shows the same split. Absolute numbers aren't comparable with the on-screen ones;
only the two engines are compared here:

| Headless | graph-2000 | diff open | diff 80 px | diff 16 px | warm open | `automaticLayout: false` |
|---|---|---|---|---|---|---|
| Chromium 153 | 60.00 fps, 0%, p99 16.8 | 257 ms | 59.90 fps, 0.17%, p99 16.8 | 60.00 fps, 0% | 70 ms | 161 ms; 60.00 fps, 0% |
| WebKit 26.6 | 60.22 fps, 4.82%, p99 29 | 2406 ms | 19.32 fps, 98.96%, p99 199 | 24.30 fps, 90.08%, p99 60 | 137 ms | 208 ms; 18.37 fps, 98.91%, p99 81 |

So the diff editor's slowness belongs to the WebKit engine's paint and decoration path for this
content, not to WebKitGTK's Linux integration, and no app-side setting fixes it. The graph, by
contrast, is fine on both engines.

A warm re-open in an existing editor is much cheaper on both (130 ms WebKit, 51.3 ms CEF): most
of the cold cost is one-time, so keeping one diff editor alive and reusing it across file
selections avoids it.

### Idle CPU

**WebKitGTK:** a first single sample read 15.183%, but four later samples (a blank page and the
graph route, with and without `WEBKIT_DISABLE_DMABUF_RENDERER=1` or
`WEBKIT_DISABLE_COMPOSITING_MODE=1`) read 0.017–2.0%, with 0 rAF calls and 2–4 renders in each
60 s window. The outlier is most likely cold OS caches on the first launch after a from-scratch
build (not confirmed), or the system stall above.

**CEF, stock:** every sample read 100.2–100.8%: one full core in the browser process's main (UI)
thread, with the renderers and GPU process idle and the page doing nothing. That thread was busy
looping: 68,052 `ppoll` calls with a zero timeout in 12.05 s, and none that blocked. A minimal
app (no plugins, `about:blank`) spins the same way, sandbox on or off.

The cause is CEF's open bug
[chromiumembedded/cef#3002](https://github.com/chromiumembedded/cef/issues/3002) ("Linux: 100% CPU
when using external-message-pump"). `tauri-runtime-cef` sets `external_message_pump`, so CEF's UI
pump is `MessagePumpExternal`, a subclass of Chromium's `MessagePumpGlib`. That base class attaches
a work source to the default GLib context, but `MessagePumpExternal` never sets the `state_` the
source's prepare callback reads, so the callback returns a zero poll timeout forever
(`message_pump_glib.cc:663-665`). The GTK 4 event loop blocks in `g_main_context_iteration(TRUE)`
on that context, and every blocking wait returns at once.

**The workaround** (about 140 lines in the runtime) destroys that one inert source right after
`cef::initialize`. The source is found structurally (its prepare callback lives in `libcef.so`, it
polls exactly one FIFO, it's recursive, and its prepare returns "not ready, timeout 0"), so the
workaround becomes a no-op if CEF fixes the bug. Afterwards the main thread sleeps with a 33 ms
timeout under the runtime's 30 Hz pump. Raising that cap to 1 s made idle worse (2.05%), so it
stays. Unpatched and patched builds, alternated, unsandboxed:

| Build | Idle, all processes (%) | graph-2000 | diff 80 px | diff open (ms) |
|---|---|---|---|---|
| unpatched (4 batches) | 100.433–100.583 | 64.55–65.76 fps, 2.13–7.28% | 63.70–65.78 fps, 1.71–4.41% | 266.2–405.2 |
| patched (4 batches) | 0.717–1.000 | 65.29–65.62 fps, 1.98–2.74% | 63.50–64.70 fps, 1.24–3.74% | 239.5–392.5 |

fps doesn't change, and the `invoke()` round trip stays at 2.2 ms (patched) vs 2.1 ms (unpatched)
median over 30 calls. Jank on the light, fixed-rate scrolls read higher patched (median 2.62% vs
1.09% at 16 px/frame); with four batches each, that small increase is neither confirmed nor ruled
out. GitBolt carries this workaround in `vendor/tauri-runtime-cef` (see `GITBOLT-PATCH.md` there,
and the upstream report in `docs/upstream/cef-3002-tauri-runtime-cef.md`).

### Memory

12 tabs: WebKitGTK 280 MB PSS; CEF **554 MB**, of which the browser process alone is about
180 MB. Under the sandbox the renderers are non-dumpable, so their PSS can't be read
(`/proc/<pid>/smaps_rollup` is root-only) and a sandboxed run only gives a partial 297 MB. The
complete figure was measured with the sandbox off. The sandbox adds only a small helper and one
zygote, so the sandboxed total should be no lower.

### Window behaviour under CEF

- **The window is always an XWayland client.** The runtime passes `--ozone-platform=x11` to every
  CEF process and sets `GDK_BACKEND=x11`, overriding an inherited `GDK_BACKEND=wayland`.
  `WebviewWindowBuilder::position()` has no effect (GTK 4 has no positioning API).
- **A custom title bar can't drag the window.** The content area is a CEF-owned foreign X11 child
  window, so every click goes to CEF and GTK never records a button press. Without one,
  `drag_window()` (behind both `data-tauri-drag-region` and `startDragging()`) fails silently, and
  so does `startResizeDragging()`. Upstream: tauri#14936 (the same bug on an older CEF, a crash
  there). GitBolt therefore keeps **native window decorations** (`decorations: true`).
- **`element.requestFullscreen()`** fills the window but doesn't fullscreen it (tauri#16025);
  Tauri's `setFullscreen()` works.
- **Works:** IPC (round trip 1.9 ms), window buttons (minimize, maximize, close), double-click
  maximize, both clipboard APIs, `setZoom`, keyboard shortcuts and in-page drag and drop (both
  checked with CDP-synthesized input only; real-mouse drag and drop on Linux CEF is reported broken
  upstream, tauri#16131). Edge resizing of an undecorated window wasn't verified; native
  decorations make it moot.
- **Zoom:** on both engines, `devicePixelRatio` follows the zoom exactly. A canvas has to redraw
  on a zoom change itself, or its backing store goes stale and drifts off the DOM rows.

### Sandboxing

Chromium's sandbox needs a root-owned setuid `chrome-sandbox` helper, because Ubuntu restricts
unprivileged user namespaces (`kernel.apparmor_restrict_unprivileged_userns=1`). Without it, a
launch aborts with "The SUID sandbox helper binary was found, but is not configured correctly".
The `.deb` ships the helper as root:root 4755, so an installed app is sandboxed with no setup. A
dev build copies a fresh, non-setuid helper next to the binary on every CEF build; see
[`docs/dev-setup.md`](../dev-setup.md) for the two ways to deal with that. An AppImage can't carry
a setuid file, so it would need unprivileged user namespaces or no sandbox (an inference, not
tested). The sandbox stayed on for every performance run except the complete-PSS one and the
before/after batches of the workaround; the stock busy loop is the same either way.

### Size and packaging

| | Size |
|---|---|
| CEF download (minimal distribution, `~/.cache/tauri-cef/`) | 321.5 MB |
| CEF extracted | 1,558.5 MB (`libcef.so` alone is 1,428 MB, with full debug info) |
| Release binary (stripped) | 11.9 MB, vs 9.25 MB on WebKitGTK, which gets everything else from the system |
| Installed `.deb` payload | 321.8 MB (`libcef.so` stripped by the bundler to 267.9 MB) |
| `.deb` file | **146.4 MB** |

- **`.deb`: works**, with the setuid helper in place. The bundler declared `Depends: libgtk-3-0`
  although the runtime links GTK 4; GitBolt's `scripts/fix-deb.sh` rewrites it to `libgtk-4-1`.
- **AppImage: failed.** The bundler's script needs `patchelf`, then failed to download two files
  from its upstream tooling (HTTP 404), independent of CEF.
- Every launch prints harmless-looking errors: `gtk_disable_setlocale() must be called before
  gtk_init()`, `GtkSettings has no property named 'gtk-modules'`, and two "Timeout of new browser
  info response for frame …".
- A launch with remote debugging disabled writes `devtools.remote_debugging.allowed=false` into
  the profile's `Local State`, and later launches that ask for a debugging port don't reset it.

## Decision and trade-offs

At the time, the spike recommended staying on WebKitGTK because of CEF's memory, download size,
alpha gaps and the runtime patch, but said CEF could be adopted with native decorations and the
#3002 workaround if those costs were acceptable. They were accepted, and GitBolt adopted CEF:

- **Diff editor:** passes on CEF; on WebKit, the problem sits in the engine, out of reach of app
  code.
- **Memory:** 554 MB vs 280 MB for 12 tabs. GitBolt's memory budget is now under 650 MB with 12
  tabs open, and its idle CPU budget under 1.5% (`just bench`).
- **Download size:** a ~146 MB `.deb` and ~322 MB installed, where WebKitGTK comes with the
  system. Building needs the ~320 MB CEF download once.
- **The setuid sandbox helper:** packages ship it setuid root; unbundled dev builds need a
  one-time install of the helper or a `chown`/`chmod` after each build. The app requires the
  sandbox (`SandboxPolicy::Required`) and won't start without it.
- **Alpha runtime:** Tauri 3.0.0-alpha.4 and `tauri-runtime-cef` 3.0.0-alpha.5 are pinned, and
  the runtime is vendored with GitBolt's patches until upstream fixes them. Known gaps: no
  custom-title-bar drag (native decorations instead), no AppImage, a wrong GTK dependency in the
  bundler's `.deb` (fixed by `scripts/fix-deb.sh`), and always XWayland.
- **Graph jank:** 1.5–1.8% janky frames, just over the < 1% threshold, at CEF's own floor; fps and
  p99 are fine.
