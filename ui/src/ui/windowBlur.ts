/**
 * A blur that only means the WINDOW lost focus, not that the user moved on (K41/K24). Under
 * GNOME, mutter answers every mouse press with WM_TAKE_FOCUS and GitBolt's CEF host refocuses
 * its browser (vendor/tauri-runtime-cef platform/linux/focus.rs), so the page sees a window blur
 * then a focus a few ms later — and the focused element gets a `blur` in between. An input that
 * commits on blur would end editing on a click inside itself. `document.hasFocus()` is false
 * during exactly those blurs; a real move to another element of the page keeps it true.
 */
export function isWindowBlur(): boolean {
  return !document.hasFocus();
}

/**
 * Called from a window-blur `onBlur`: once the window has focus again, puts the caret back in
 * `el` (the browser doesn't always restore it after the WM's bounce), unless `still()` says
 * editing ended meanwhile.
 */
export function refocusWhenWindowReturns(el: HTMLElement | null, still: () => boolean = () => true): void {
  const back = () => {
    window.removeEventListener('focus', back);
    if (el && el.isConnected && still() && document.activeElement !== el) el.focus({ preventScroll: true });
  };
  window.addEventListener('focus', back);
}
