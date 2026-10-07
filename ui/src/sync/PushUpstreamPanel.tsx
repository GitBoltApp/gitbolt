import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import type { PushTarget } from '../api/gen/PushTarget';
import { useModalKeys } from '../app/modalKeys';
import { usePopoverPlace } from '../ui/arm/anchor';
import { currentOrigin, originRect, type Origin } from '../ui/arm/origin';
import { confirmable } from '../ui/arm/store';
import { Select } from '../ui/Select';
import { swallowGestureClick } from '../ui/swallowClick';
import './push.css';

/** Where a branch with no upstream goes, and whether it tracks it. */
export interface PushAnswer { target: PushTarget; track: boolean }

interface Req { id: number; branch: string; remotes: string[]; origin: Origin | null; resolve(a: PushAnswer | null): void }
let nextId = 0;
const useAsk = create<{ req: Req | null }>(() => ({ req: null }));

/** The branch field's width: its text's (`ch`, with room for the caret). The CSS bounds it, from
 * 220px up to the panel's width, so a long name shows in full. */
export const branchWidth = (text: string): string => `${Math.max(text.length, 1) + 3}ch`;

/**
 * Asks where a branch with no upstream goes (spec #2 §12.3): a panel dropped from where the push
 * started (`origin`: the Push button, the menu row's place), in the anchored-popover family
 * (boards E, G). `null` on Cancel, Esc, a press outside or a newer ask.
 */
export function askPushTarget(branch: string, remotes: string[], origin: Origin | null = currentOrigin()): Promise<PushAnswer | null> {
  useAsk.getState().req?.resolve(null);
  const sorted = [...remotes].sort((a, b) => Number(b === 'origin') - Number(a === 'origin'));
  return new Promise((resolve) => useAsk.setState({ req: { id: ++nextId, branch, remotes: sorted, origin, resolve } }));
}

export function PushUpstreamPanel() {
  const req = useAsk((s) => s.req);
  return req ? <Panel req={req} key={req.id} /> : null;
}

function Panel({ req }: { req: Req }) {
  const [remote, setRemote] = useState(req.remotes[0]);
  const [branch, setBranch] = useState(req.branch);
  const [track, setTrack] = useState(true);
  const done = (a: PushAnswer | null) => {
    if (useAsk.getState().req !== req) return;
    useAsk.setState({ req: null });
    req.resolve(a);
  };
  const doneRef = useRef(done);
  doneRef.current = done;
  const ref = useModalKeys<HTMLFormElement>(true, () => done(null));
  const anchor = useMemo(() => originRect(req.origin), [req.origin]);
  const pos = usePopoverPlace(ref, anchor);
  // A press outside cancels; the remote's dropdown (the app's menu) is part of it.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target instanceof Element ? e.target : null;
      if (t && (ref.current?.contains(t) || t.closest('.ctx-menu'))) return;
      // A press on the control that started the push (the Push button) closes it, as a toggle:
      // its click must not push again and reopen the panel.
      const trigger = req.origin?.via === 'pointer' && req.origin.control ? req.origin.el : null;
      if (t && trigger?.contains(t)) swallowGestureClick((c) => c.target instanceof Node && trigger.contains(c.target));
      doneRef.current(null);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [ref, req.origin]);
  // Push takes the focus (after the focus trap's own: React's dev double effects re-run it).
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[data-autofocus]')?.focus({ preventScroll: true }); }, [ref]);
  // The settle guard (as a popover's choice): the press or held Enter that opened it never pushes.
  const [openedAt] = useState(() => ({ at: performance.now() }));
  const ok = branch.trim() !== '';
  return (
    <form
      ref={ref}
      data-arm-popover=""
      className="arm-popover push-panel"
      role="dialog"
      aria-modal="true"
      aria-label={`Push ${req.branch} to a remote`}
      style={pos ?? { opacity: 0, left: 0, top: 0 }}
      onSubmit={(e) => e.preventDefault()}
    >
      <div className="push-target">
        <span>{`Push ${req.branch} to`}</span>
        <span className="push-where">
          <Select<string> aria-label="Remote" value={remote} options={req.remotes.map((r) => [r, r] as const)} onChange={setRemote} />
          <span aria-hidden>/</span>
          <input aria-label="Branch" value={branch} onChange={(e) => setBranch(e.target.value)} spellCheck={false} style={{ width: branchWidth(branch) }} />
        </span>
      </div>
      <label className="modal-check">
        <input type="checkbox" checked={track} onChange={(e) => setTrack(e.target.checked)} />
        Track it
      </label>
      <div className="modal-actions">
        <button type="button" className="choice-cancel" onClick={() => done(null)}>Cancel</button>
        {/* Enter in the field submits through this button's click (`detail` 0). */}
        <button type="submit" className="primary positive" disabled={!ok} data-autofocus="" onClick={(e) => { if (ok && confirmable(e.nativeEvent, openedAt)) done({ target: { remote, branch: branch.trim() }, track }); }}>Push</button>
      </div>
    </form>
  );
}
