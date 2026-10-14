import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api/client';
import { useAppInfo, useTilde } from '../app/appInfo';
import { arm } from '../ui/arm/store';
import './updates.css';

/** The first start's notice, shown once: either answer dismisses it for good, but closing the app
 *  unanswered shows it again (the Settings row is the keyboard path to the same action). */
export const LEGACY_NOTICE_KEY = 'gitvolt.legacyBundleNotice.v1';

const seen = (): boolean => {
  try { return localStorage.getItem(LEGACY_NOTICE_KEY) !== null; } catch { return false; }
};
const markSeen = () => {
  try { localStorage.setItem(LEGACY_NOTICE_KEY, '1'); } catch { /* shown again next start */ }
};

/** The folder a bundle sits in, for display. */
const folderOf = (path: string) => path.replace(/[\\/][^\\/]*$/, '') || '/';

/**
 * "Move GitBolt.app to the Trash": the first click arms it (the label says what the second does,
 * in red), the second runs it; Esc or a click elsewhere cancels. No modal, no timer. The core
 * checks again that it is GitBolt's and that GitBolt isn't running.
 */
export function RemoveLegacyBundle({ onDone, onError }: { onDone?: () => void; onError?: (message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const run = async () => {
    const ok = await arm({ arm: 'Move GitBolt.app to the Trash', tone: 'danger', title: 'Move GitBolt.app to the Trash', body: 'GitVolt replaced it. It stays in the Trash until you empty it.', confirmLabel: 'Move to the Trash' });
    if (!ok) return;
    setBusy(true);
    try {
      await api.updateRemoveLegacyBundle();
      useAppInfo.setState((s) => ({ info: s.info && { ...s.info, legacyBundle: null } }));
      onDone?.();
    } catch (e) {
      onError?.(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };
  return <button type="button" disabled={busy} data-arm-origin="" onClick={() => void run()}>Remove GitBolt.app</button>;
}

/** Settings › Updates: shown only while a GitBolt.app sits beside this app. */
export function LegacyBundleRow() {
  const path = useAppInfo((s) => s.info?.legacyBundle);
  const tilde = useTilde();
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { void useAppInfo.getState().load().catch(() => {}); }, []);
  if (!path) return null;
  return (
    <div className="setting-row" data-setting-id="legacyBundle" id="setting-legacyBundle">
      <span className="setting-label">GitBolt.app, this app&apos;s old version, is still in {tilde(folderOf(path))}.</span>
      <div className="setting-control">
        <RemoveLegacyBundle onError={setError} />
        {error && <p className="update-message error" role="alert">{error}</p>}
      </div>
    </div>
  );
}

/** The one-time notice on the first start with a GitBolt.app beside this app. */
export function LegacyBundleNotice() {
  const path = useAppInfo((s) => s.info?.legacyBundle);
  const tilde = useTilde();
  const [gone, setGone] = useState(false);
  useEffect(() => { void useAppInfo.getState().load().catch(() => {}); }, []);
  const [error, setError] = useState<string | null>(null);
  if (!path || gone || seen()) return null;
  const close = () => { markSeen(); setGone(true); };
  return (
    <div className="legacy-notice" role="region" aria-label="GitBolt.app is still installed">
      <p>GitBolt.app, this app&apos;s old version, is still in {tilde(folderOf(path))}. Remove it?</p>
      {error && <p className="update-message error" role="alert">{error}</p>}
      <div className="modal-actions">
        <RemoveLegacyBundle onDone={close} onError={setError} />
        <button type="button" onClick={close}>Keep</button>
      </div>
    </div>
  );
}
