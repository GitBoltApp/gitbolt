import { X } from 'lucide-react';
import { useLayoutEffect, useRef } from 'react';
import { isDismissKey } from './HoverTooltip';
import { useKeys } from './keyRouter';
import { useToast, type ToastAction } from './toastStore';

export function Toast() {
  const message = useToast((s) => s.message);
  const action = useToast((s) => s.action);
  const actions = useToast((s) => s.actions);
  const tone = useToast((s) => s.tone);
  const detail = useToast((s) => s.detail);
  const sticky = useToast((s) => s.sticky);
  const box = useRef<HTMLDivElement>(null);
  // Esc dismisses a sticky toast, in the app layer: an open modal (menu layer) takes Esc first.
  useKeys('app', (e) => {
    if (!isDismissKey(e)) return;
    useToast.getState().dismiss();
    e.preventDefault();
    return 'handled';
  }, sticky && !!message);
  const links: ToastAction[] = action ? [action, ...actions] : actions;
  // Warnings and anything that invites input (links) show at the top, below the toolbar; plain notices stay at the bottom.
  const top = !!message && (tone === 'warning' || links.length > 0);
  // ...and below an open flyout's title bar (an MR/PR view's header) when they'd cover it.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el || !top) return;
    el.style.setProperty('--toast-below', `${belowFlyoutHeads(el.getBoundingClientRect())}px`);
  }, [top, message, links.length, detail]);
  if (!message) return null;
  return (
    <div ref={box} role={tone === 'warning' ? 'alert' : 'status'} onMouseEnter={() => useToast.getState().hold()} onMouseLeave={() => useToast.getState().release()} className={`toast${tone === 'warning' ? ' toast-warning' : ''}${top ? ' toast-top' : ''}`}>
      {message}
      {links.map((a, i) => (
        <button key={`${i}-${a.label}`} type="button" className="toast-action" onClick={() => { useToast.getState().dismiss(); a.run(); }}>{a.label}</button>
      ))}
      {sticky && <button type="button" className="toast-dismiss" aria-label="Dismiss" onClick={() => useToast.getState().dismiss()}><X size={14} /></button>}
      {detail && <div className="toast-detail">{detail}</div>}
    </div>
  );
}

/** Where a top toast at `rect` goes clear of the flyout title bars it would cover: below the
 * lowest, 8 px apart; 0 when it covers none (one in a hidden tab has no box). */
export function belowFlyoutHeads(rect: DOMRect): number {
  let below = 0;
  for (const head of document.querySelectorAll('.flyout-head')) {
    const h = head.getBoundingClientRect();
    if (h.height > 0 && h.left < rect.right && h.right > rect.left) below = Math.max(below, h.bottom + 8);
  }
  return below;
}
