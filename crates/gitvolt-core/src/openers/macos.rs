//! macOS dialogs: the folder picker and the "Other…" app chooser, both an `NSOpenPanel`, as a
//! sheet on the main window when there is one.
//!
//! AppKit panels live on the main thread, but the API asks from a blocking worker. The worker
//! hands the panel to the main dispatch queue, which the app's `NSApplication` run loop drains,
//! and waits on a channel for the completion handler. The main thread never waits: the panel
//! starts and returns. `runModal` would spin a nested run loop inside winit's and CEF's.

use super::{ArgStyle, ExecArg, LaunchCommand, Opener, OpenerKind, CHOOSER_ID};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{channel, Sender};

/// Runs `show` on the main thread through `run_on_main` and waits for the folder or app it sends
/// back. `None` when the user cancels, when `show` or its job is dropped without answering, and
/// at once when another panel is open (`busy`).
fn ask(busy: &AtomicBool, run_on_main: impl FnOnce(Box<dyn FnOnce() + Send>), show: impl FnOnce(Sender<Option<PathBuf>>) + Send + 'static) -> Option<PathBuf> {
    if busy.swap(true, Ordering::AcqRel) {
        // Info, not debug: after a panel that never answers, this line is the only trace.
        tracing::info!("a panel is still open, so this request gets nothing");
        return None;
    }
    let (reply, answer) = channel();
    run_on_main(Box::new(move || show(reply)));
    let picked = answer.recv().ok().flatten();
    busy.store(false, Ordering::Release);
    picked
}

#[cfg(target_os = "macos")]
static PANEL_OPEN: AtomicBool = AtomicBool::new(false);

#[cfg(target_os = "macos")]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Choose {
    Folder,
    App,
}

/// Asks for one folder, starting in `start` when given. `None` when the user cancels.
#[cfg(target_os = "macos")]
pub(super) fn pick_folder(start: Option<&Path>) -> Option<PathBuf> {
    let start = start.map(Path::to_path_buf);
    ask(&PANEL_OPEN, on_main_queue, move |reply| show_panel(Choose::Folder, start.as_deref(), reply))
}

/// "Other…": asks for an app, then opens `file` in it. A cancel opens nothing. `open` hands the
/// launch to LaunchServices, so the app gets the user's session environment, and `hook` only
/// adjusts `open` itself.
#[cfg(target_os = "macos")]
pub(super) fn open_with_chosen_app(file: &Path, hook: &dyn Fn(&mut std::process::Command)) -> Result<(), crate::error::GbError> {
    let chosen = ask(&PANEL_OPEN, on_main_queue, |reply| show_panel(Choose::App, Some(Path::new("/Applications")), reply));
    match chosen {
        Some(app) => super::spawn_detached_with(&open_with_command(&app, file), hook),
        None => Ok(()),
    }
}

/// `open -a <app> <file>`, the app by its absolute path so LaunchServices doesn't look it up by
/// name (`mac_detect.rs` opens launcher-less editors the same way).
fn open_with_command(app: &Path, file: &Path) -> LaunchCommand {
    let args = vec![ExecArg::Literal("-a".into()), ExecArg::Literal(app.as_os_str().to_owned()), ExecArg::File];
    Opener::new(CHOOSER_ID, "Other…", OpenerKind::Chooser, "/usr/bin/open", ArgStyle::Exec(args)).command(file, None)
}

#[cfg(target_os = "macos")]
fn on_main_queue(job: Box<dyn FnOnce() + Send>) {
    dispatch2::DispatchQueue::main().exec_async(job);
}

/// The path of a `file://` URL. `to_file_path` alone would turn any URL's path into one.
#[cfg(target_os = "macos")]
fn file_path(url: &objc2_foundation::NSURL) -> Option<PathBuf> {
    if url.isFileURL() { url.to_file_path() } else { None }
}

/// The folder or app a closed panel gives back: `path` on OK, nothing otherwise.
#[cfg(target_os = "macos")]
fn picked(response: objc2_app_kit::NSModalResponse, path: impl FnOnce() -> Option<PathBuf>) -> Option<PathBuf> {
    if response != objc2_app_kit::NSModalResponseOK {
        if response == objc2_app_kit::NSModalResponseAbort {
            tracing::warn!("the open panel couldn't be shown (NSModalResponseAbort)");
        }
        return None;
    }
    let path = path();
    if path.is_none() {
        tracing::warn!("the open panel answered OK with no local file or folder");
    }
    path
}

#[cfg(target_os = "macos")]
fn show_panel(choose: Choose, start: Option<&Path>, reply: Sender<Option<PathBuf>>) {
    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSApplication, NSModalResponse, NSOpenPanel};
    use objc2_foundation::{NSArray, NSURL};
    use std::cell::Cell;

    // Dropping `reply` here makes the picker answer `None`.
    let Some(mtm) = MainThreadMarker::new() else {
        tracing::warn!("the open panel's job ran, but not on the main thread");
        return;
    };
    let panel = NSOpenPanel::openPanel(mtm);
    panel.setAllowsMultipleSelection(false);
    match choose {
        Choose::Folder => {
            panel.setCanChooseDirectories(true);
            panel.setCanChooseFiles(false);
            // Create Worktree usually points at a folder that doesn't exist yet.
            panel.setCanCreateDirectories(true);
        }
        Choose::App => {
            panel.setCanChooseDirectories(false);
            panel.setCanChooseFiles(true);
            // SAFETY: a constant the UniformTypeIdentifiers framework exports for the process's life.
            let apps = unsafe { objc2_uniform_type_identifiers::UTTypeApplicationBundle };
            panel.setAllowedContentTypes(&NSArray::from_slice(&[apps]));
        }
    }
    if let Some(url) = start.and_then(NSURL::from_directory_path) {
        panel.setDirectoryURL(Some(&url));
    }
    let answered = panel.clone();
    // The block is `Fn`, so the sender sits in a cell and is taken by the one call AppKit makes.
    let reply = Cell::new(Some(reply));
    let done = RcBlock::new(move |response: NSModalResponse| {
        let picked = picked(response, || answered.URL().and_then(|url| file_path(&url)));
        if let Some(reply) = reply.take() {
            let _ = reply.send(picked);
        }
    });
    match NSApplication::sharedApplication(mtm).mainWindow() {
        Some(window) => panel.beginSheetModalForWindow_completionHandler(&window, &done),
        None => panel.beginWithCompletionHandler(&done),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn on_this_thread(job: Box<dyn FnOnce() + Send>) {
        job()
    }

    /// What `run` logs at `level` and above, on this thread.
    fn logged(level: tracing::Level, run: impl FnOnce()) -> String {
        #[derive(Clone, Default)]
        struct Buf(std::sync::Arc<std::sync::Mutex<Vec<u8>>>);
        impl std::io::Write for Buf {
            fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
                self.0.lock().unwrap().extend_from_slice(b);
                Ok(b.len())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let buf = Buf::default();
        let out = buf.clone();
        let sub = tracing_subscriber::fmt().with_writer(move || out.clone()).with_ansi(false).with_max_level(level).finish();
        tracing::subscriber::with_default(sub, run);
        String::from_utf8(buf.0.lock().unwrap().clone()).unwrap()
    }

    #[test]
    fn a_request_turned_away_by_an_open_panel_says_so() {
        let busy = AtomicBool::new(true);
        let text = logged(tracing::Level::INFO, || assert_eq!(ask(&busy, |_| panic!("a second panel was shown"), |_| {}), None));
        assert!(text.contains("INFO") && text.contains("a panel is still open"), "{text}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_panel_job_off_the_main_thread_answers_nothing_and_says_why() {
        let (reply, answer) = channel();
        let text = logged(tracing::Level::WARN, || show_panel(Choose::Folder, None, reply));
        assert!(answer.recv().is_err(), "the reply was dropped, so the worker gets None");
        assert!(text.contains("WARN") && text.contains("not on the main thread"), "{text}");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn only_a_panel_that_failed_or_an_ok_without_a_path_is_a_warning() {
        use objc2_app_kit::{NSModalResponseAbort, NSModalResponseCancel, NSModalResponseOK};
        let quiet = logged(tracing::Level::WARN, || {
            assert_eq!(picked(NSModalResponseOK, || Some(PathBuf::from("/w/repos"))), Some(PathBuf::from("/w/repos")));
            assert_eq!(picked(NSModalResponseCancel, || unreachable!("a cancel has no path to read")), None);
        });
        assert_eq!(quiet, "", "a pick and a cancel are normal");
        let failed = logged(tracing::Level::WARN, || assert_eq!(picked(NSModalResponseAbort, || unreachable!()), None));
        assert!(failed.contains("WARN") && failed.contains("couldn't be shown"), "{failed}");
        let pathless = logged(tracing::Level::WARN, || assert_eq!(picked(NSModalResponseOK, || None), None));
        assert!(pathless.contains("WARN") && pathless.contains("no local file or folder"), "{pathless}");
    }

    #[test]
    fn the_panel_answer_comes_back_to_the_caller() {
        let busy = AtomicBool::new(false);
        let picked = ask(&busy, on_this_thread, |reply| {
            let _ = reply.send(Some(PathBuf::from("/Users/ada/repos")));
        });
        assert_eq!(picked, Some(PathBuf::from("/Users/ada/repos")));
        assert_eq!(ask(&busy, on_this_thread, |reply| { let _ = reply.send(None); }), None, "cancelled");
    }

    #[test]
    fn a_panel_that_never_answers_gives_nothing_instead_of_hanging() {
        let busy = AtomicBool::new(false);
        assert_eq!(ask(&busy, on_this_thread, drop), None, "the completion block was dropped unrun");
        assert_eq!(ask(&busy, drop, |_| unreachable!()), None, "the main-thread job was dropped unrun");
        assert!(!busy.load(Ordering::SeqCst), "free for the next panel");
    }

    #[test]
    fn a_second_request_while_a_panel_is_open_gets_nothing_and_the_first_still_answers() {
        let busy = AtomicBool::new(false);
        let (jobs, pending) = channel::<Box<dyn FnOnce() + Send>>();
        std::thread::scope(|s| {
            let first = s.spawn(|| ask(&busy, |job| jobs.send(job).unwrap(), |reply| { let _ = reply.send(Some(PathBuf::from("/w/first"))); }));
            let open_panel = pending.recv().unwrap();
            assert_eq!(ask(&busy, |_| panic!("a second panel was shown"), |_| {}), None);
            open_panel();
            assert_eq!(first.join().unwrap(), Some(PathBuf::from("/w/first")));
        });
        assert!(!busy.load(Ordering::SeqCst));
    }

    #[test]
    fn the_chosen_app_opens_the_file_by_the_apps_path() {
        let cmd = open_with_command(Path::new("/Applications/Xcode.app"), Path::new("/r/-a b.swift"));
        assert_eq!(cmd.program, PathBuf::from("/usr/bin/open"));
        assert_eq!(cmd.args, ["-a", "/Applications/Xcode.app", "/r/-a b.swift"].map(std::ffi::OsString::from), "the file is one absolute argument, never an option");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn only_file_urls_map_to_paths() {
        use objc2_foundation::{NSString, NSURL};
        use std::os::unix::fs::MetadataExt;
        let dir = tempfile::tempdir().unwrap();
        for name in ["My Repos", "Übung"] {
            let folder = dir.path().join(name);
            std::fs::create_dir(&folder).unwrap();
            let picked = file_path(&NSURL::from_file_path(&folder).unwrap()).unwrap();
            // Foundation may hand back decomposed Unicode: what matters is that it's the same folder.
            let (a, b) = (std::fs::metadata(&picked).unwrap(), std::fs::metadata(&folder).unwrap());
            assert_eq!((a.dev(), a.ino()), (b.dev(), b.ino()), "{name}");
        }
        let web = NSURL::URLWithString(&NSString::from_str("https://example.com/x")).unwrap();
        assert_eq!(file_path(&web), None);
    }
}
