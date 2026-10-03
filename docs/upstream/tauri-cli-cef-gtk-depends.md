# Upstream report draft: tauri-cli declares GTK 3 for CEF apps on Linux

Not filed; filing is the user's call.

---

Target: `tauri-apps/tauri` (`crates/tauri-cli`).

**Title:** [bug] tauri-cli (v3 alpha): `.deb`/`.rpm` of a `tauri-runtime-cef` app depend on GTK 3, but the app links GTK 4

### Describe the bug

`Runtime::linux_dependencies()` in `tauri-cli` 3.0.0-alpha.3 (`src/runtime/mod.rs:65-80`) returns
`libgtk-3-0` / `libgtk-3.so.0` for every runtime ("`tauri` itself uses GTK on Linux, whatever the
runtime"). `tauri-runtime-cef` 3.0.0-alpha.4 runs on `tauri-winit-gtk4`, whose binaries link
`libgtk-4.so.1`, and doesn't load GTK 3. `interface/rust.rs:1467` appends these dependencies after
`bundle.linux.deb.depends` / `rpm.depends`, so an app can add GTK 4 but can't remove GTK 3:

    Depends: libgtk-4-1, git (>= 1:2.40), libgtk-3-0

### Expected

For `Runtime::Cef`, declare `libgtk-4-1` / `libgtk-4.so.1`; or let `bundle.linux.*.depends`
replace the runtime defaults.

### Workaround we use

After bundling, rewrite only the `.deb` control member (drop `libgtk-3-0`, add `dpkg-shlibdeps`
results), keeping the data member byte-identical so `chrome-sandbox` stays root:root 4755.
