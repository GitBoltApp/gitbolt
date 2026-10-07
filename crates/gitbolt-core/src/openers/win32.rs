//! The Windows shell's own pieces: the URL handler (`ShellExecuteW`), the Open With dialog
//! (`SHOpenWithDialog`) and the folder picker (`IFileOpenDialog`).
//!
//! Each runs on a thread of its own, in a COM single-threaded apartment as the shell's dialogs
//! and handlers expect, so a modal dialog never holds one of the core's runtime threads and
//! never depends on whatever apartment such a thread is in. The program the shell starts gets
//! GitBolt's environment: there's no `Command` for `ChildEnvHook` to adjust.

use crate::error::GbError;
use std::ffi::{c_void, OsString};
use std::os::windows::ffi::OsStringExt;
use std::path::{Path, PathBuf};
use windows::core::{w, HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_CANCELLED, HWND};
use windows::Win32::System::Com::{CoCreateInstance, CoInitializeEx, CoTaskMemFree, CoUninitialize, IBindCtx, CLSCTX_INPROC_SERVER, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE};
use windows::Win32::UI::Shell::{
    FileOpenDialog, IFileOpenDialog, IShellItem, SHCreateItemFromParsingName, SHOpenWithDialog, ShellExecuteW, FOS_FORCEFILESYSTEM, FOS_PATHMUSTEXIST, FOS_PICKFOLDERS, OAIF_EXEC, OPENASINFO,
    SIGDN_FILESYSPATH,
};
use windows::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

/// Runs `f` on a new thread inside a COM single-threaded apartment.
fn on_sta_thread<T: Send + 'static>(name: &str, f: impl FnOnce() -> T + Send + 'static) -> std::io::Result<std::thread::JoinHandle<T>> {
    std::thread::Builder::new().name(name.into()).spawn(move || {
        // SAFETY: a fresh thread; uninitialized below, on the same thread, only if this succeeded.
        let init = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) };
        let out = f();
        if init.is_ok() {
            unsafe { CoUninitialize() };
        }
        out
    })
}

fn joined<T>(handle: std::io::Result<std::thread::JoinHandle<Result<T, GbError>>>, what: &str) -> Result<T, GbError> {
    handle.map_err(|e| GbError::other(format!("couldn't start the {what}: {e}")))?.join().map_err(|_| GbError::other(format!("the {what} failed")))?
}

/// Opens `url` (checked: `http(s)://` or `mailto:`) with its default handler, as the shell's
/// `open` verb does. Waits for the shell's answer, which comes once the handler has started.
pub(super) fn open_url(url: &str) -> Result<(), GbError> {
    let url = HSTRING::from(url);
    joined(
        on_sta_thread("open url", move || {
            // SAFETY: every string outlives the call; no window and no parameters.
            let done = unsafe { ShellExecuteW(None, w!("open"), &url, PCWSTR::null(), PCWSTR::null(), SW_SHOWNORMAL) };
            // Above 32 is success; anything else is an error code (ShellExecuteW's docs).
            if done.0 as isize > 32 { Ok(()) } else { Err(GbError::other(format!("couldn't open {url}: no handler answered (code {})", done.0 as isize))) }
        }),
        "link opener",
    )
}

/// Shows Windows's Open With dialog for `file`, which starts the program the user picks
/// (`OAIF_EXEC`). The dialog is modal until the user is done, so it gets its own thread and this
/// returns at once; a failure is logged, a cancel is not.
pub(super) fn open_with_dialog(file: &Path) -> Result<(), GbError> {
    let file = HSTRING::from(file);
    on_sta_thread("open with", move || {
        let info = OPENASINFO { pcszFile: PCWSTR(file.as_ptr()), pcszClass: PCWSTR::null(), oaifInFlags: OAIF_EXEC };
        // SAFETY: `info` and the string it points to live until the dialog returns.
        match unsafe { SHOpenWithDialog(None, &info) } {
            Err(e) if e.code() != ERROR_CANCELLED.to_hresult() => tracing::warn!("the Open With dialog for {file} failed: {e}"),
            _ => {}
        }
    })
    .map(drop)
    .map_err(|e| GbError::other(format!("couldn't show the Open With dialog: {e}")))
}

/// Asks for a folder (`IFileOpenDialog` picking folders), starting in `start` when it exists,
/// owned by the window `parent` when given. `Ok(None)` when the user cancels.
pub(super) fn pick_folder(start: Option<&Path>, parent: Option<isize>) -> Result<Option<PathBuf>, GbError> {
    let start = start.map(Path::to_path_buf);
    joined(on_sta_thread("folder picker", move || pick(start.as_deref(), parent).map_err(|e| GbError::other(format!("the folder picker failed: {e}")))), "folder picker")
}

fn pick(start: Option<&Path>, parent: Option<isize>) -> windows::core::Result<Option<PathBuf>> {
    // SAFETY: COM calls on this thread's apartment (`on_sta_thread`); `parent` is the app's own
    // window, which outlives the dialog, or none.
    unsafe {
        let dialog: IFileOpenDialog = CoCreateInstance(&FileOpenDialog, None, CLSCTX_INPROC_SERVER)?;
        dialog.SetOptions(dialog.GetOptions()? | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST)?;
        // A start folder that's gone is simply not used.
        if let Some(item) = start.and_then(|s| SHCreateItemFromParsingName::<_, _, IShellItem>(&HSTRING::from(s), None::<&IBindCtx>).ok()) {
            let _ = dialog.SetFolder(&item);
        }
        match dialog.Show(parent.map(|h| HWND(h as *mut c_void))) {
            Err(e) if e.code() == ERROR_CANCELLED.to_hresult() => return Ok(None),
            shown => shown?,
        }
        let name = dialog.GetResult()?.GetDisplayName(SIGDN_FILESYSPATH)?;
        let path = PathBuf::from(OsString::from_wide(name.as_wide()));
        CoTaskMemFree(Some(name.0 as *const c_void));
        Ok(Some(path))
    }
}
