import { inTauri } from '../api/transport';

/** Window state the background-fetch scheduler needs (spec §15): the app's window in Tauri, the
 * page in the harness browser. */
export interface Platform {
  isMinimized(): Promise<boolean>;
  onFocusChanged(cb: (focused: boolean) => void): () => void;
}

declare global {
  /** e2e: pretend the window is minimized. */
  interface Window { __gbTestMinimized?: boolean }
}

const tauriPlatform: Platform = {
  isMinimized: async () => (await import('@tauri-apps/api/window')).getCurrentWindow().isMinimized(),
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
  isMinimized: async () => (import.meta.env.DEV && window.__gbTestMinimized === true) || document.visibilityState === 'hidden',
  onFocusChanged(cb) {
    const on = () => cb(true);
    const offFocus = () => cb(false);
    window.addEventListener('focus', on);
    window.addEventListener('blur', offFocus);
    return () => { window.removeEventListener('focus', on); window.removeEventListener('blur', offFocus); };
  },
};

export const platform: Platform = inTauri() ? tauriPlatform : browserPlatform;
