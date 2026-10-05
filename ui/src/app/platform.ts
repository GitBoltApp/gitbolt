import { inTauri } from '../api/transport';

/** Window state the background-fetch scheduler needs (spec §15): the app's window in Tauri, the
 * page in the harness browser. */
export interface Platform {
  isMinimized(): Promise<boolean>;
  /** The window has the focus now (the forge poller polls only then). */
  isFocused(): Promise<boolean>;
  onFocusChanged(cb: (focused: boolean) => void): () => void;
}

declare global {
  /** e2e: pretend the window is minimized. */
  interface Window { __gbTestMinimized?: boolean }
}

const tauriPlatform: Platform = {
  isMinimized: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().isMinimized(),
  isFocused: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().isFocused(),
  onFocusChanged(cb) {
    let off: (() => void) | undefined;
    let dead = false;
    void import('@tauri-apps/api/window')
      .then(({ getCurrentWindow }) => getCurrentWindow().onFocusChanged((e) => cb(e.payload)))
      .then((unlisten) => { if (dead) unlisten(); else off = unlisten; })
      .catch((e: unknown) => console.warn('[gitbolt] window focus events unavailable', e));
    return () => { dead = true; off?.(); };
  },
};

const browserPlatform: Platform = {
  isMinimized: async () => ((import.meta.env.DEV || import.meta.env.MODE === 'e2e') && window.__gbTestMinimized === true) || document.visibilityState === 'hidden',
  // A headless browser (e2e) may never give the page the focus: it counts as focused there.
  isFocused: async () => import.meta.env.MODE === 'e2e' || document.hasFocus(),
  onFocusChanged(cb) {
    const on = () => cb(true);
    const offFocus = () => cb(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', offFocus);
    return () => { window.removeEventListener('focus', on); window.removeEventListener('blur', offFocus); };
  },
};

export const platform: Platform = inTauri() ? tauriPlatform : browserPlatform;
