import { useEffect } from 'react';
import { create } from 'zustand';
import { useAppInfo } from './appInfo';
import { useModalKeys } from './modalKeys';

export const useAbout = create<{ open: boolean; setOpen(v: boolean): void }>((set) => ({
  open: false,
  setOpen: (open) => set({ open }),
}));

/** Help > About GitBolt (spec §6.1): the app version and the git version in use. */
export function About() {
  const open = useAbout((s) => s.open);
  const setOpen = useAbout((s) => s.setOpen);
  const info = useAppInfo((s) => s.info);
  const close = () => setOpen(false);
  const ref = useModalKeys<HTMLDivElement>(open, close);
  useEffect(() => {
    if (open) void useAppInfo.getState().load();
  }, [open]);
  if (!open) return null;
  return (
    <div className="modal-backdrop" onPointerDown={close}>
      <div ref={ref} className="modal" role="dialog" aria-label="About GitBolt" onPointerDown={(e) => e.stopPropagation()}>
        <h2>GitBolt</h2>
        <p>Version {info?.appVersion ?? '…'}</p>
        <p>git {info?.gitVersion ?? '…'}</p>
        <div className="modal-actions">
          <button type="button" autoFocus onClick={close}>Close</button>
        </div>
      </div>
    </div>
  );
}
