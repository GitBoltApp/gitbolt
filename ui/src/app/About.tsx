import { lazy, Suspense, useEffect, useState } from 'react';
import { create } from 'zustand';
import { useAppInfo } from './appInfo';
import { useModalKeys } from './modalKeys';

export const useAbout = create<{ open: boolean; setOpen(v: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

// The licenses page loads on first use: none of it is in the startup bundle.
const Licenses = lazy(() => import('./Licenses'));

/** Help > About GitBolt (spec §6.1): the app version and the git version in use, and the open
 *  source licenses (the notices the build ships, docs/licensing.md). */
export function About() {
  const open = useAbout((s) => s.open);
  const setOpen = useAbout((s) => s.setOpen);
  const info = useAppInfo((s) => s.info);
  const [page, setPage] = useState<'about' | 'licenses'>('about');
  const close = () => setOpen(false);
  const ref = useModalKeys<HTMLDivElement>(open, close);
  useEffect(() => {
    if (open) void useAppInfo.getState().load();
    else setPage('about');
  }, [open]);
  if (!open) return null;
  const licenses = page === 'licenses';
  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div ref={ref} className={licenses ? 'modal about-licenses' : 'modal'} role="dialog" aria-label={licenses ? 'Open source licenses' : 'About GitBolt'} onPointerDown={(e) => e.stopPropagation()}>
        {licenses ? (
          <>
            <h2>Open source licenses</h2>
            <Suspense fallback={<p aria-busy="true">Loading…</p>}>
              <Licenses />
            </Suspense>
            <div className="modal-actions">
              <button type="button" autoFocus onClick={() => setPage('about')}>Back</button>
              <button type="button" onClick={close}>Close</button>
            </div>
          </>
        ) : (
          <>
            <h2>GitBolt</h2>
            <p>Version {info?.appVersion ?? '…'}</p>
            <p>git {info?.gitVersion ?? '…'}</p>
            <div className="modal-actions">
              <button type="button" onClick={() => setPage('licenses')}>Open source licenses</button>
              <button type="button" autoFocus onClick={close}>Close</button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
