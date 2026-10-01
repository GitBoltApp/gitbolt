//! K46: the main window reopens where it was — same monitor, position, size and maximized state.
//!
//! The geometry lives in `AppSettings::window` (logical pixels, see `WindowGeometry`). At
//! startup [`placement`] checks it against the monitors present now and the window is built
//! with that position and size, so it maps there directly (winit-gtk4 applies a builder position
//! at realize, before the window is first shown: no jump). It is maximized right after, if it was.
//! Afterwards every move or resize saves it again, debounced, and the close saves it once more.
//! A maximized or minimized window keeps the last normal rect, plus `maximized`.
//!
//! The vendored CEF runtime supports all of it through winit-gtk4 on X11 (`outer_position`,
//! `set_position`, `inner_size`, `is_maximized`/`is_minimized`, the monitors with their work
//! areas, and the `Moved`/`Resized`/`CloseRequested` events), so it needed no patch. Under Wayland
//! (only when `GDK_BACKEND` isn't x11) a window can't place itself: only the size and the
//! maximized state come back.

use gitbolt_core::settings::{MonitorIdentity, SettingsStore, WindowGeometry, SAVE_DEBOUNCE};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tauri::{Monitor, Runtime, WebviewWindow, WindowEvent};

/// Less of the window than this on screen (of its area, over all work areas) and it's re-centred.
pub const MIN_VISIBLE: f64 = 0.5;

/// A rect in logical pixels.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl Rect {
    pub fn new(x: f64, y: f64, width: f64, height: f64) -> Self {
        Self { x, y, width, height }
    }

    fn area(&self) -> f64 {
        self.width.max(0.0) * self.height.max(0.0)
    }

    fn intersection_area(&self, other: &Rect) -> f64 {
        let w = (self.x + self.width).min(other.x + other.width) - self.x.max(other.x);
        let h = (self.y + self.height).min(other.y + other.height) - self.y.max(other.y);
        w.max(0.0) * h.max(0.0)
    }

    fn same_as(&self, other: &Rect) -> bool {
        const EPS: f64 = 0.5;
        (self.x - other.x).abs() < EPS && (self.y - other.y).abs() < EPS && (self.width - other.width).abs() < EPS && (self.height - other.height).abs() < EPS
    }
}

/// A monitor present now, in logical pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct Screen {
    pub name: Option<String>,
    pub bounds: Rect,
    /// The bounds minus panels and docks.
    pub work_area: Rect,
}

impl Screen {
    pub fn identity(&self) -> MonitorIdentity {
        MonitorIdentity { name: self.name.clone(), x: self.bounds.x, y: self.bounds.y, width: self.bounds.width, height: self.bounds.height }
    }
}

/// How to build the window: its outer position (none: the window manager picks), its inner size,
/// and whether to maximize it once shown.
#[derive(Debug, Clone, PartialEq)]
pub struct Placement {
    pub position: Option<(f64, f64)>,
    pub size: (f64, f64),
    pub maximized: bool,
}

fn identity_rect(id: &MonitorIdentity) -> Rect {
    Rect::new(id.x, id.y, id.width, id.height)
}

/// The screen that is the saved monitor: the one with its name (the one at the same place, if
/// several share it), or, for a monitor saved without a name, the one with the same rect.
fn find_screen<'a>(id: &MonitorIdentity, screens: &'a [Screen]) -> Option<&'a Screen> {
    let rect = identity_rect(id);
    match &id.name {
        Some(name) => {
            let mut named = screens.iter().filter(|s| s.name.as_deref() == Some(name.as_str()));
            let first = named.clone().next();
            named.find(|s| s.bounds.same_as(&rect)).or(first)
        }
        None => screens.iter().find(|s| s.bounds.same_as(&rect)),
    }
}

/// `(w, h)` no larger than `area`, and whether each axis was shrunk.
fn clamp_size((w, h): (f64, f64), area: &Rect) -> ((f64, f64), bool, bool) {
    let cw = w.min(area.width);
    let ch = h.min(area.height);
    ((cw, ch), cw < w, ch < h)
}

fn centred_on(screen: &Screen, size: (f64, f64)) -> Placement {
    let (size, _, _) = clamp_size(size, &screen.work_area);
    let wa = screen.work_area;
    let x = wa.x + (wa.width - size.0) / 2.0;
    let y = wa.y + (wa.height - size.1) / 2.0;
    Placement { position: Some((x.round(), y.round())), size, maximized: false }
}

/// Where the saved window goes on the monitors present now; `None` if the saved geometry is
/// unusable (the window then opens at its configured default).
///
/// On its saved monitor (found by name, even if it moved in the layout) it keeps its place
/// relative to that monitor, shrunk to the monitor's work area if it no longer fits. If that
/// monitor is gone, or the window would be mostly off every work area, it's centred on the
/// primary monitor with its saved size, clamped to the work area. Without `can_position`
/// (Wayland), only its size comes back, clamped to the primary monitor.
pub fn placement(saved: &WindowGeometry, screens: &[Screen], primary: Option<usize>, can_position: bool) -> Option<Placement> {
    let size = (saved.width, saved.height);
    if !(size.0.is_finite() && size.1.is_finite() && size.0 >= 1.0 && size.1 >= 1.0) {
        return None;
    }
    let maximized = saved.maximized;
    let primary = primary.and_then(|i| screens.get(i)).or(screens.first());
    let Some(primary) = primary else {
        return Some(Placement { position: None, size, maximized });
    };
    let with_maximized = |p: Placement| Some(Placement { maximized, ..p });
    let position = match (saved.x, saved.y) {
        (Some(x), Some(y)) if x.is_finite() && y.is_finite() => Some((x, y)),
        _ => None,
    };
    let Some((x, y)) = position.filter(|_| can_position) else {
        let (size, _, _) = clamp_size(size, &primary.work_area);
        return Some(Placement { position: None, size, maximized });
    };

    let target = match &saved.monitor {
        Some(id) => find_screen(id, screens).map(|s| (s, s.bounds.x - id.x, s.bounds.y - id.y)),
        // No monitor saved: whichever holds most of the window.
        None => {
            let rect = Rect::new(x, y, size.0, size.1);
            screens
                .iter()
                .map(|s| (s, rect.intersection_area(&s.work_area)))
                .filter(|(_, a)| *a > 0.0)
                .max_by(|a, b| a.1.total_cmp(&b.1))
                .map(|(s, _)| (s, 0.0, 0.0))
        }
    };
    let Some((screen, dx, dy)) = target else {
        return with_maximized(centred_on(primary, size));
    };
    let wa = screen.work_area;
    let (size, shrunk_w, shrunk_h) = clamp_size(size, &wa);
    let mut x = x + dx;
    let mut y = y + dy;
    // A window shrunk to fit is moved onto the work area along that axis.
    if shrunk_w {
        x = wa.x;
    }
    if shrunk_h {
        y = wa.y;
    }
    let rect = Rect::new(x, y, size.0, size.1);
    let visible: f64 = screens.iter().map(|s| rect.intersection_area(&s.work_area)).sum();
    if visible < MIN_VISIBLE * rect.area() {
        return with_maximized(centred_on(primary, size));
    }
    Some(Placement { position: Some((x, y)), size, maximized })
}

/// What the window reports now, in logical pixels.
#[derive(Debug, Clone, PartialEq)]
pub struct Observed {
    pub position: Option<(f64, f64)>,
    pub size: (f64, f64),
    pub maximized: bool,
    pub minimized: bool,
    pub monitor: Option<MonitorIdentity>,
}

fn same_monitor(a: &MonitorIdentity, b: &MonitorIdentity) -> bool {
    match (&a.name, &b.name) {
        (Some(x), Some(y)) => x == y,
        _ => identity_rect(a).same_as(&identity_rect(b)),
    }
}

/// The geometry to save after observing the window; `None` keeps what was saved (a minimized
/// window). A maximized one keeps the last normal rect (or the default size, if there's none
/// yet) with `maximized` set; maximized onto another monitor, that rect moves with it.
pub fn next_saved(prev: Option<&WindowGeometry>, now: Observed, default_size: (f64, f64)) -> Option<WindowGeometry> {
    if now.minimized {
        return None;
    }
    if !now.maximized {
        let (x, y) = now.position.unzip();
        return Some(WindowGeometry { x, y, width: now.size.0, height: now.size.1, maximized: false, monitor: now.monitor });
    }
    let mut g = prev.cloned().unwrap_or(WindowGeometry { width: default_size.0, height: default_size.1, ..Default::default() });
    g.maximized = true;
    match (&g.monitor, &now.monitor) {
        (Some(old), Some(new)) if !same_monitor(old, new) => {
            if let (Some(x), Some(y)) = (g.x, g.y) {
                g.x = Some(x - old.x + new.x);
                g.y = Some(y - old.y + new.y);
            }
            g.monitor = Some(new.clone());
        }
        (None, Some(new)) => g.monitor = Some(new.clone()),
        _ => {}
    }
    Some(g)
}

/// Whether this process's windows can place themselves: X11, not Wayland. `GDK_BACKEND` is a
/// list in order of preference; without it, GDK picks Wayland when `WAYLAND_DISPLAY` is set.
pub fn can_self_position(gdk_backend: Option<&str>, wayland_display: Option<&str>) -> bool {
    match gdk_backend.map(str::trim).filter(|b| !b.is_empty()) {
        Some(list) => list.split(',').next().is_some_and(|first| first.trim() == "x11"),
        None => wayland_display.is_none_or(str::is_empty),
    }
}

/// This process, now: the CEF runtime forces `GDK_BACKEND=x11` before GTK starts.
pub fn can_self_position_now() -> bool {
    let backend = std::env::var("GDK_BACKEND").ok();
    let wayland = std::env::var("WAYLAND_DISPLAY").ok();
    can_self_position(backend.as_deref(), wayland.as_deref())
}

fn logical_rect(x: f64, y: f64, w: f64, h: f64, scale: f64) -> Rect {
    let s = if scale > 0.0 { scale } else { 1.0 };
    Rect::new(x / s, y / s, w / s, h / s)
}

pub fn screen_of(m: &Monitor) -> Screen {
    let s = m.scale_factor();
    let (p, z, wa) = (m.position(), m.size(), m.work_area());
    Screen {
        name: m.name().cloned(),
        bounds: logical_rect(p.x.into(), p.y.into(), z.width.into(), z.height.into(), s),
        work_area: logical_rect(wa.position.x.into(), wa.position.y.into(), wa.size.width.into(), wa.size.height.into(), s),
    }
}

/// The monitors present now and which of them is the primary one.
pub fn screens(available: &[Monitor], primary: Option<&Monitor>) -> (Vec<Screen>, Option<usize>) {
    let screens: Vec<Screen> = available.iter().map(screen_of).collect();
    let primary = primary.map(screen_of).and_then(|p| screens.iter().position(|s| s.name == p.name && s.bounds.same_as(&p.bounds)));
    (screens, primary)
}

struct Tracker {
    store: Arc<SettingsStore>,
    /// Bumped by every move/resize; a debounced save runs only if it's still the latest.
    generation: AtomicU64,
    can_position: bool,
    default_size: (f64, f64),
}

impl Tracker {
    fn observe<R: Runtime>(&self, w: &WebviewWindow<R>) -> tauri::Result<Observed> {
        let scale = w.scale_factor()?;
        let scale = if scale > 0.0 { scale } else { 1.0 };
        let position = if self.can_position { w.outer_position().ok().map(|p| (f64::from(p.x) / scale, f64::from(p.y) / scale)) } else { None };
        let size = w.inner_size()?;
        Ok(Observed {
            position,
            size: (f64::from(size.width) / scale, f64::from(size.height) / scale),
            maximized: w.is_maximized()?,
            minimized: w.is_minimized()?,
            monitor: w.current_monitor().ok().flatten().map(|m| screen_of(&m).identity()),
        })
    }

    fn save<R: Runtime>(&self, w: &WebviewWindow<R>) {
        match self.observe(w) {
            Ok(now) => {
                if let Some(g) = next_saved(self.store.window().as_ref(), now, self.default_size) {
                    self.store.save_window(g);
                }
            }
            Err(e) => tracing::debug!("window geometry unavailable: {e}"),
        }
    }
}

/// Saves the window's geometry on every move and resize (debounced like the settings file,
/// `SAVE_DEBOUNCE`) and once more when it's asked to close.
pub fn track<R: Runtime>(window: &WebviewWindow<R>, store: Arc<SettingsStore>, can_position: bool, default_size: (f64, f64)) {
    let tracker = Arc::new(Tracker { store, generation: AtomicU64::new(0), can_position, default_size });
    let w = window.clone();
    window.on_window_event(move |event| match event {
        WindowEvent::Moved(_) | WindowEvent::Resized(_) | WindowEvent::ScaleFactorChanged { .. } => {
            let generation = tracker.generation.fetch_add(1, Ordering::SeqCst) + 1;
            let (tracker, w) = (tracker.clone(), w.clone());
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(SAVE_DEBOUNCE).await;
                if tracker.generation.load(Ordering::SeqCst) == generation {
                    // The getters block on the event loop: off the async workers.
                    let _ = tauri::async_runtime::spawn_blocking(move || tracker.save(&w)).await;
                }
            });
        }
        // On the main thread, inside the runtime's event dispatch, where its getters are
        // answered inline (`RuntimeContext::send_message`). The exit flush then writes it.
        WindowEvent::CloseRequested { .. } => {
            tracker.generation.fetch_add(1, Ordering::SeqCst);
            tracker.save(&w);
        }
        _ => {}
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn screen(name: &str, x: f64, y: f64, w: f64, h: f64) -> Screen {
        // A 32 px top bar, like GNOME's.
        Screen { name: Some(name.into()), bounds: Rect::new(x, y, w, h), work_area: Rect::new(x, y + 32.0, w, h - 32.0) }
    }

    fn laptop() -> Screen {
        screen("eDP-1", 0.0, 0.0, 1920.0, 1200.0)
    }

    fn external() -> Screen {
        screen("DP-1", 1920.0, 0.0, 2560.0, 1440.0)
    }

    fn saved_on(s: &Screen, x: f64, y: f64, w: f64, h: f64) -> WindowGeometry {
        WindowGeometry { x: Some(x), y: Some(y), width: w, height: h, maximized: false, monitor: Some(s.identity()) }
    }

    #[test]
    fn a_window_on_a_monitor_still_there_comes_back_in_place() {
        let g = saved_on(&external(), 2100.0, 100.0, 1600.0, 900.0);
        let p = placement(&g, &[laptop(), external()], Some(0), true).unwrap();
        assert_eq!(p, Placement { position: Some((2100.0, 100.0)), size: (1600.0, 900.0), maximized: false });
    }

    #[test]
    fn a_monitor_that_moved_in_the_layout_takes_the_window_with_it() {
        let g = saved_on(&external(), 2100.0, 100.0, 1600.0, 900.0);
        // The external monitor is now left of the laptop.
        let moved = screen("DP-1", -2560.0, 0.0, 2560.0, 1440.0);
        let p = placement(&g, &[laptop(), moved], Some(0), true).unwrap();
        assert_eq!(p.position, Some((-2560.0 + 180.0, 100.0)));
    }

    #[test]
    fn a_monitor_that_is_gone_centres_the_window_on_the_primary_one() {
        let g = saved_on(&external(), 2100.0, 100.0, 1600.0, 900.0);
        let p = placement(&g, &[laptop()], Some(0), true).unwrap();
        // Work area 0,32 1920x1168.
        assert_eq!(p, Placement { position: Some((160.0, 166.0)), size: (1600.0, 900.0), maximized: false });
    }

    #[test]
    fn the_fallback_clamps_the_saved_size_to_the_work_area() {
        let g = saved_on(&external(), 1920.0, 32.0, 2560.0, 1400.0);
        let p = placement(&g, &[laptop()], Some(0), true).unwrap();
        assert_eq!(p, Placement { position: Some((0.0, 32.0)), size: (1920.0, 1168.0), maximized: false });
    }

    #[test]
    fn a_window_mostly_offscreen_is_recentred() {
        // On its monitor by name, but 90 % off the right edge of everything.
        let g = saved_on(&laptop(), 1800.0, 100.0, 1200.0, 800.0);
        let p = placement(&g, &[laptop()], Some(0), true).unwrap();
        assert_eq!(p.position, Some((360.0, 216.0)));
        // Half on screen is enough to stay.
        let g = saved_on(&laptop(), 1320.0, 100.0, 1200.0, 800.0);
        assert_eq!(placement(&g, &[laptop()], Some(0), true).unwrap().position, Some((1320.0, 100.0)));
    }

    #[test]
    fn a_window_too_big_for_its_smaller_monitor_shrinks_onto_it() {
        // Same connector, lower resolution now.
        let g = saved_on(&external(), 1940.0, 40.0, 2500.0, 1380.0);
        let smaller = screen("DP-1", 1920.0, 0.0, 1920.0, 1080.0);
        let p = placement(&g, &[laptop(), smaller], Some(0), true).unwrap();
        assert_eq!(p, Placement { position: Some((1920.0, 32.0)), size: (1920.0, 1048.0), maximized: false });
    }

    #[test]
    fn the_primary_monitor_is_the_fallback_not_the_first() {
        let g = saved_on(&screen("HDMI-1", 5000.0, 0.0, 1920.0, 1080.0), 5100.0, 100.0, 1000.0, 600.0);
        let p = placement(&g, &[laptop(), external()], Some(1), true).unwrap();
        // DP-1's work area: 1920,32 2560x1408.
        assert_eq!(p.position, Some((1920.0 + 780.0, 32.0 + 404.0)));
    }

    #[test]
    fn maximized_comes_back_on_top_of_the_normal_rect_even_on_fallback() {
        let mut g = saved_on(&external(), 2100.0, 100.0, 1600.0, 900.0);
        g.maximized = true;
        assert!(placement(&g, &[laptop(), external()], Some(0), true).unwrap().maximized);
        let p = placement(&g, &[laptop()], Some(0), true).unwrap();
        assert!(p.maximized);
        assert_eq!(p.position, Some((160.0, 166.0)));
    }

    #[test]
    fn without_self_positioning_only_the_size_comes_back() {
        let mut g = saved_on(&external(), 2100.0, 100.0, 2400.0, 900.0);
        g.maximized = true;
        let p = placement(&g, &[laptop(), external()], Some(0), false).unwrap();
        assert_eq!(p, Placement { position: None, size: (1920.0, 900.0), maximized: true });
        // Saved on Wayland: no position at all.
        let g = WindowGeometry { width: 1200.0, height: 700.0, ..Default::default() };
        assert_eq!(placement(&g, &[laptop()], Some(0), true).unwrap().position, None);
    }

    #[test]
    fn a_monitor_saved_without_a_name_is_matched_by_its_rect() {
        let mut g = saved_on(&external(), 2100.0, 100.0, 1600.0, 900.0);
        g.monitor.as_mut().unwrap().name = None;
        let unnamed = Screen { name: None, ..external() };
        assert_eq!(placement(&g, &[laptop(), unnamed], Some(0), true).unwrap().position, Some((2100.0, 100.0)));
        // Different rect: gone.
        let other = Screen { name: None, ..screen("", 1920.0, 0.0, 1920.0, 1080.0) };
        assert_eq!(placement(&g, &[laptop(), other], Some(0), true).unwrap().position, Some((160.0, 166.0)));
    }

    #[test]
    fn unusable_or_screenless_geometry() {
        let g = WindowGeometry { width: 0.0, height: 700.0, ..Default::default() };
        assert_eq!(placement(&g, &[laptop()], Some(0), true), None);
        let g = WindowGeometry { width: f64::NAN, height: 700.0, ..Default::default() };
        assert_eq!(placement(&g, &[laptop()], Some(0), true), None);
        let g = saved_on(&laptop(), 10.0, 40.0, 1000.0, 700.0);
        assert_eq!(placement(&g, &[], None, true), Some(Placement { position: None, size: (1000.0, 700.0), maximized: false }));
    }

    fn observed(x: f64, y: f64, w: f64, h: f64, monitor: &Screen) -> Observed {
        Observed { position: Some((x, y)), size: (w, h), maximized: false, minimized: false, monitor: Some(monitor.identity()) }
    }

    #[test]
    fn a_normal_window_saves_what_it_sees() {
        let g = next_saved(None, observed(100.0, 50.0, 1400.0, 800.0, &laptop()), (1600.0, 900.0)).unwrap();
        assert_eq!(g, saved_on(&laptop(), 100.0, 50.0, 1400.0, 800.0));
    }

    #[test]
    fn maximized_keeps_the_last_normal_rect() {
        let prev = saved_on(&laptop(), 100.0, 50.0, 1400.0, 800.0);
        let now = Observed { maximized: true, ..observed(0.0, 32.0, 1920.0, 1168.0, &laptop()) };
        let g = next_saved(Some(&prev), now, (1600.0, 900.0)).unwrap();
        assert_eq!(g, WindowGeometry { maximized: true, ..prev });
    }

    #[test]
    fn maximized_with_nothing_saved_yet_keeps_the_default_size() {
        let now = Observed { maximized: true, ..observed(0.0, 32.0, 1920.0, 1168.0, &laptop()) };
        let g = next_saved(None, now, (1600.0, 900.0)).unwrap();
        assert_eq!(g, WindowGeometry { x: None, y: None, width: 1600.0, height: 900.0, maximized: true, monitor: Some(laptop().identity()) });
    }

    #[test]
    fn maximized_onto_another_monitor_moves_the_normal_rect_along() {
        let prev = saved_on(&laptop(), 100.0, 50.0, 1400.0, 800.0);
        let now = Observed { maximized: true, ..observed(1920.0, 32.0, 2560.0, 1408.0, &external()) };
        let g = next_saved(Some(&prev), now, (1600.0, 900.0)).unwrap();
        assert_eq!(g, WindowGeometry { maximized: true, ..saved_on(&external(), 2020.0, 50.0, 1400.0, 800.0) });
        // And it restores there, maximized.
        let p = placement(&g, &[laptop(), external()], Some(0), true).unwrap();
        assert_eq!(p, Placement { position: Some((2020.0, 50.0)), size: (1400.0, 800.0), maximized: true });
    }

    #[test]
    fn minimized_saves_nothing() {
        let prev = saved_on(&laptop(), 100.0, 50.0, 1400.0, 800.0);
        let now = Observed { minimized: true, ..observed(-32000.0, -32000.0, 160.0, 28.0, &laptop()) };
        assert_eq!(next_saved(Some(&prev), now, (1600.0, 900.0)), None);
    }

    #[test]
    fn self_positioning_only_on_x11() {
        assert!(can_self_position(Some("x11"), Some("wayland-0")));
        assert!(can_self_position(Some("x11,wayland"), None));
        assert!(!can_self_position(Some("wayland"), None));
        assert!(!can_self_position(Some("wayland,x11"), Some("wayland-0")));
        assert!(can_self_position(None, None));
        assert!(can_self_position(Some(""), Some("")));
        assert!(!can_self_position(None, Some("wayland-0")));
    }
}
