//! Log files (spec §16.2): daily rotation, the newest 7 files kept, `info` by default and `debug`
//! switchable at run time from Settings. Only GitBolt's own crates log below `warn`; dependencies
//! (gix, tokio, the CEF runtime's `log` records) stay at `warn` so the file stays readable.
//! Every byte written to a file passes through `redact` (defence in depth: no secret in a log).

use crate::error::GbError;
use crate::log::{truncate_utf8, STDERR_LOG_LIMIT};
use crate::redact::redact;
use serde::Deserialize;
use std::io::Write;
use std::path::{Path, PathBuf};
use tracing_appender::non_blocking::WorkerGuard;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{fmt, reload, EnvFilter, Registry};
use ts_rs::TS;

pub const KEEP_FILES: usize = 7;
/// A file past this many bytes rolls to `gitbolt.DAY.N.log`; the kept files together stay under `TOTAL_CAP`.
pub const MAX_FILE_BYTES: u64 = 10 * 1024 * 1024;
pub const TOTAL_CAP: u64 = 50 * 1024 * 1024;
pub const FILE_PREFIX: &str = "gitbolt";

/// `~/.cache/gitbolt/logs` (`paths::cache_dir()`, which honours `$XDG_CACHE_HOME`).
pub fn default_log_dir() -> PathBuf {
    crate::paths::cache_dir().join("logs")
}

fn filter(debug: bool) -> EnvFilter {
    // `RUST_LOG` overrides the default until debug logging is switched on from Settings.
    if let Some(f) = std::env::var("RUST_LOG").ok().filter(|_| !debug).and_then(|env| EnvFilter::try_new(env).ok()) {
        return f;
    }
    let level = if debug { "debug" } else { "info" };
    // `gitbolt` is the app binary's crate name and the frontend's target.
    EnvFilter::new(format!("warn,gitbolt={level},gitbolt_core={level},gitbolt_forge={level},gitbolt_harness={level}"))
}

#[derive(Clone)]
pub struct LogHandle {
    reload: reload::Handle<EnvFilter, Registry>,
    dir: PathBuf,
}

impl LogHandle {
    pub fn set_debug(&self, debug: bool) -> Result<(), GbError> {
        self.reload.reload(filter(debug)).map_err(|e| GbError::other(format!("log level: {e}")))
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

/// Keep `guard` alive for the whole process: dropping it flushes and stops the file writer.
pub struct Logging {
    pub handle: LogHandle,
    pub guard: WorkerGuard,
}

/// A writer that redacts each write (tracing's fmt layer writes one event per call), so neither
/// the files nor the terminal ever show a secret.
#[derive(Clone)]
struct RedactingWriter<W: Write>(W);

impl<W: Write> Write for RedactingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let text = String::from_utf8_lossy(buf);
        self.0.write_all(redact(&text).as_bytes())?;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.0.flush()
    }
}

/// Today's UTC date as `YYYY-MM-DD` (civil-from-days, no date crate needed).
fn today() -> String {
    let days = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs() / 86_400).unwrap_or(0) as i64;
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    format!("{y:04}-{m:02}-{d:02}")
}

/// Daily files that also roll past `max_file` bytes, with the newest `KEEP_FILES` kept and their
/// total under `total_cap`. The directory is 0700 and the files 0600.
struct RollingFile {
    dir: PathBuf,
    max_file: u64,
    total_cap: u64,
    day: String,
    seq: u32,
    file: Option<std::fs::File>,
    written: u64,
}

fn is_log(name: &str) -> bool {
    name.starts_with(&format!("{FILE_PREFIX}.")) && name.ends_with(".log")
}

impl RollingFile {
    fn new(dir: &Path, max_file: u64, total_cap: u64) -> std::io::Result<Self> {
        use crate::platform::fs as pfs;
        pfs::private_dir_builder(std::fs::DirBuilder::new().recursive(true)).create(dir)?;
        pfs::set_mode(dir, 0o700)?;
        for e in std::fs::read_dir(dir)?.flatten() {
            if is_log(&e.file_name().to_string_lossy()) {
                let _ = pfs::set_mode(e.path(), 0o600);
            }
        }
        let mut me = Self { dir: dir.to_path_buf(), max_file, total_cap, day: today(), seq: 0, file: None, written: 0 };
        me.open_next()?;
        Ok(me)
    }

    /// Opens the first file of `self.day` (from `self.seq` up) that still has room, then prunes.
    fn open_next(&mut self) -> std::io::Result<()> {
        loop {
            let name = if self.seq == 0 { format!("{FILE_PREFIX}.{}.log", self.day) } else { format!("{FILE_PREFIX}.{}.{}.log", self.day, self.seq) };
            let path = self.dir.join(name);
            let len = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
            if len >= self.max_file {
                self.seq += 1;
                continue;
            }
            self.file = Some(crate::platform::fs::private_file(std::fs::OpenOptions::new().create(true).append(true)).open(&path)?);
            self.written = len;
            self.prune(&path);
            return Ok(());
        }
    }

    fn prune(&self, current: &Path) {
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return };
        let mut files: Vec<(std::time::SystemTime, u64, PathBuf)> = rd
            .flatten()
            .filter(|e| is_log(&e.file_name().to_string_lossy()))
            .filter_map(|e| e.metadata().ok().map(|m| (m.modified().unwrap_or(std::time::UNIX_EPOCH), m.len(), e.path())))
            .collect();
        files.sort_by_key(|a| std::cmp::Reverse(a.0)); // newest first
        let mut total = 0;
        for (i, (_, len, path)) in files.iter().enumerate() {
            total += len;
            if path != current && (i >= KEEP_FILES || total > self.total_cap) {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

impl Write for RollingFile {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        let day = today();
        if day != self.day {
            self.day = day;
            self.seq = 0;
            self.open_next()?;
        } else if self.written + buf.len() as u64 > self.max_file && self.written > 0 {
            self.seq += 1;
            self.open_next()?;
        }
        let file = self.file.as_mut().ok_or_else(|| std::io::Error::other("log file closed"))?;
        file.write_all(buf)?;
        self.written += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> std::io::Result<()> {
        self.file.as_mut().map_or(Ok(()), |f| f.flush())
    }
}

/// Builds the subscriber without installing it (tests use `tracing::subscriber::with_default`).
/// `also_console`: a redacted copy of every line on stdout.
pub fn build(dir: &Path, debug: bool, also_console: bool) -> Result<(impl tracing::Subscriber + Send + Sync + 'static, Logging), GbError> {
    let appender = RollingFile::new(dir, MAX_FILE_BYTES, TOTAL_CAP).map_err(|e| GbError::other(format!("log file: {e}")))?;
    let (writer, guard) = tracing_appender::non_blocking(appender);
    let writer = RedactingWriter(writer);
    let (filter_layer, reload) = reload::Layer::new(filter(debug));
    let subscriber = tracing_subscriber::registry()
        .with(filter_layer)
        .with(fmt::layer().with_writer(move || writer.clone()).with_ansi(false).with_target(true))
        .with(also_console.then(|| fmt::layer().with_writer(|| RedactingWriter(std::io::stdout()))));
    Ok((subscriber, Logging { handle: LogHandle { reload, dir: dir.to_path_buf() }, guard }))
}

/// Console-only logging (redacted) for when the log files can't be opened.
pub fn init_console_fallback() {
    let _ = tracing_subscriber::registry()
        .with(filter(false))
        .with(fmt::layer().with_writer(|| RedactingWriter(std::io::stdout())))
        .try_init();
    install_panic_hook();
}

/// Installs the subscriber globally and the panic hook.
pub fn init(dir: &Path, debug: bool, also_console: bool) -> Result<Logging, GbError> {
    let (subscriber, logging) = build(dir, debug, also_console)?;
    subscriber.try_init().map_err(|e| GbError::other(format!("logging init: {e}")))?;
    install_panic_hook();
    Ok(logging)
}

/// Logs every panic with its location and a backtrace captured at the panic site, and prints a
/// redacted line to stderr. `api::catch_panics` turns the unwinding request into a `GbError`
/// (spec §16.1). The default hook prints the raw message to stderr, which a desktop launch sends
/// to the journal, so it only runs in debug builds (tests rely on its output there); release
/// builds print `panic_stderr_line` instead (1D final review I1).
pub fn install_panic_hook() {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let backtrace = std::backtrace::Backtrace::force_capture();
        let location = info.location().map(|l| l.to_string()).unwrap_or_default();
        let text = panic_text(info.payload());
        tracing::error!(target: "gitbolt_core::panic", location = %location, "panic: {text}\n{backtrace}");
        if cfg!(debug_assertions) {
            previous(info);
        } else {
            eprintln!("{}", panic_stderr_line(&location, &text));
        }
    }));
}

/// The stderr line a release build prints for a panic: redacted like every log line.
pub(crate) fn panic_stderr_line(location: &str, text: &str) -> String {
    redact(&format!("GitBolt panicked at {location}: {text}"))
}

pub(crate) fn panic_text(payload: &(dyn std::any::Any + Send)) -> String {
    payload
        .downcast_ref::<&str>()
        .map(|s| s.to_string())
        .or_else(|| payload.downcast_ref::<String>().cloned())
        .unwrap_or_else(|| "unknown panic payload".into())
}

#[derive(Debug, Clone, Copy, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum FrontendLevel {
    Error,
    Warn,
    Info,
}

/// A frontend error or notice, redacted and truncated like git stderr (spec §16.2).
pub fn log_frontend(level: FrontendLevel, message: &str, stack: Option<&str>) {
    let message = redact(truncate_utf8(message, STDERR_LOG_LIMIT));
    let stack = stack.map(|s| redact(truncate_utf8(s, STDERR_LOG_LIMIT))).unwrap_or_default();
    match level {
        FrontendLevel::Error => tracing::error!(target: "gitbolt::frontend", stack = %stack, "{message}"),
        FrontendLevel::Warn => tracing::warn!(target: "gitbolt::frontend", stack = %stack, "{message}"),
        FrontendLevel::Info => tracing::info!(target: "gitbolt::frontend", "{message}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// What a release build prints to stderr for a panic is redacted (1D final review I1).
    #[test]
    fn the_release_panic_stderr_line_is_redacted() {
        let token = format!("glpat-{}", "d".repeat(24));
        let line = panic_stderr_line("src/x.rs:1:2", &format!("bad remote https://u:{token}@h/r.git"));
        assert!(line.starts_with("GitBolt panicked at src/x.rs:1:2: "), "{line}");
        assert!(!line.contains(&token), "{line}");
    }

    fn read_logs(dir: &Path) -> String {
        let mut out = String::new();
        for e in std::fs::read_dir(dir).unwrap() {
            let p = e.unwrap().path();
            if p.extension().is_some_and(|x| x == "log") {
                out.push_str(&std::fs::read_to_string(p).unwrap());
            }
        }
        out
    }

    #[test]
    fn writes_info_and_toggles_debug_at_run_time() {
        let dir = tempfile::tempdir().unwrap();
        let (sub, logging) = build(dir.path(), false, false).unwrap();
        tracing::subscriber::with_default(sub, || {
            tracing::info!(target: "gitbolt_core::t", "info-line");
            tracing::debug!(target: "gitbolt_core::t", "debug-hidden");
            logging.handle.set_debug(true).unwrap();
            tracing::debug!(target: "gitbolt_core::t", "debug-shown");
            tracing::debug!(target: "gix::t", "dependency-debug");
            tracing::warn!(target: "gix::t", "dependency-warn");
        });
        let Logging { guard, .. } = logging;
        drop(guard); // flushes the non-blocking writer
        let text = read_logs(dir.path());
        assert!(text.contains("info-line"));
        assert!(!text.contains("debug-hidden"));
        assert!(text.contains("debug-shown"));
        assert!(!text.contains("dependency-debug"), "dependencies stay at warn");
        assert!(text.contains("dependency-warn"));
        assert!(!text.contains("\u{1b}["), "no ANSI colors in files");
    }

    #[test]
    fn names_files_by_day_and_keeps_seven() {
        let dir = tempfile::tempdir().unwrap();
        for d in 1..=9 {
            std::fs::write(dir.path().join(format!("gitbolt.2020-01-0{d}.log")), "old\n").unwrap();
            std::thread::sleep(std::time::Duration::from_millis(15)); // distinct creation times
        }
        std::fs::write(dir.path().join("unrelated.txt"), "keep me").unwrap();
        let (_sub, logging) = build(dir.path(), false, false).unwrap();
        drop(logging);
        let mut logs: Vec<String> = std::fs::read_dir(dir.path()).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).filter(|n| n.ends_with(".log")).collect();
        logs.sort();
        assert_eq!(logs.len(), KEEP_FILES, "{logs:?}");
        assert!(!logs.contains(&"gitbolt.2020-01-01.log".to_string()), "oldest pruned first: {logs:?}");
        assert!(logs.iter().any(|n| n.starts_with("gitbolt.20") && !n.starts_with("gitbolt.2020")), "today's file exists: {logs:?}");
        assert!(dir.path().join("unrelated.txt").exists());
    }

    #[test]
    fn frontend_log_is_redacted() {
        let dir = tempfile::tempdir().unwrap();
        let (sub, logging) = build(dir.path(), false, false).unwrap();
        let token = format!("glpat-{}", "a".repeat(24));
        tracing::subscriber::with_default(sub, || {
            log_frontend(FrontendLevel::Error, &format!("fetch https://me:{token}@gitlab.example.com/x.git failed"), Some("at f (app.js:1)"));
        });
        let Logging { guard, .. } = logging;
        drop(guard);
        let text = read_logs(dir.path());
        assert!(text.contains("gitbolt::frontend"));
        assert!(text.contains("https://***@gitlab.example.com/x.git"));
        assert!(!text.contains(&token));
        assert!(text.contains("at f (app.js:1)"));
    }

    #[test]
    fn backend_lines_are_redacted_too() {
        let dir = tempfile::tempdir().unwrap();
        let (sub, logging) = build(dir.path(), false, false).unwrap();
        let token = format!("glpat-{}", "b".repeat(24));
        tracing::subscriber::with_default(sub, || {
            tracing::warn!(target: "gitbolt_core::t", "remote https://u:{token}@h.example.com/r.git");
        });
        let Logging { guard, .. } = logging;
        drop(guard);
        let text = read_logs(dir.path());
        assert!(text.contains("h.example.com") && !text.contains(&token), "{text}");
    }

    #[test]
    fn dir_is_private_and_files_roll_by_size_under_a_total_cap() {
        let dir = tempfile::tempdir().unwrap();
        let logs = dir.path().join("logs");
        std::fs::create_dir_all(&logs).unwrap();
        std::fs::write(logs.join("gitbolt.2020-01-01.log"), "old").unwrap(); // 0644 before startup
        let mut w = RollingFile::new(&logs, 100, 250).unwrap();
        for _ in 0..20 {
            w.write_all(&[b'x'; 60]).unwrap();
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        // Modes on Unix only (Windows: private by the profile's ACL).
        let mode = |p: &Path| crate::platform::fs::mode(&std::fs::metadata(p).unwrap()) & 0o777;
        if cfg!(unix) {
            assert_eq!(mode(&logs), 0o700);
        }
        let mut total = 0;
        for e in std::fs::read_dir(&logs).unwrap() {
            let e = e.unwrap();
            if cfg!(unix) {
                assert_eq!(mode(&e.path()), 0o600, "{:?}", e.path());
            }
            assert!(e.metadata().unwrap().len() <= 100);
            total += e.metadata().unwrap().len();
        }
        assert!(total <= 250 + 100, "bounded: {total}");
        assert!(!logs.join("gitbolt.2020-01-01.log").exists());
    }

    #[test]
    fn today_is_a_plausible_date() {
        let d = today();
        assert!(d.starts_with("20") && d.len() == 10, "{d}");
    }

    #[test]
    fn the_panic_hook_logs_redacted_and_chains_to_the_previous_hook() {
        use std::sync::atomic::{AtomicBool, Ordering};
        use std::sync::Arc;
        let dir = tempfile::tempdir().unwrap();
        let (sub, logging) = build(dir.path(), false, false).unwrap();
        let chained = Arc::new(AtomicBool::new(false));
        let flag = chained.clone();
        let original = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |_| flag.store(true, Ordering::SeqCst)));
        install_panic_hook();
        let token = format!("glpat-{}", "c".repeat(24));
        tracing::subscriber::with_default(sub, || {
            let _ = std::panic::catch_unwind(|| panic!("failed for https://u:{token}@h.example.com/r.git"));
        });
        drop(std::panic::take_hook());
        std::panic::set_hook(original);
        assert!(chained.load(Ordering::SeqCst), "previous hook ran");
        let Logging { guard, .. } = logging;
        drop(guard);
        let text = read_logs(dir.path());
        assert!(text.contains("panic:") && text.contains("h.example.com") && !text.contains(&token), "{text}");
    }

    #[test]
    fn default_dir_is_under_the_cache_dir() {
        assert_eq!(default_log_dir(), crate::paths::cache_dir().join("logs"));
        assert!(default_log_dir().ends_with(std::path::Path::new(crate::paths::APP_DIR).join("logs")));
    }
}
