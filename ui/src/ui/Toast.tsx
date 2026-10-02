import { X } from 'lucide-react';
import { isDismissKey } from './HoverTooltip';
import { useKeys } from './keyRouter';
import { useToast, type ToastAction } from './toast';

export function Toast() {
  const message = useToast((s) => s.message);
  const action = useToast((s) => s.action);
  const actions = useToast((s) => s.actions);
  const tone = useToast((s) => s.tone);
  const detail = useToast((s) => s.detail);
  const sticky = useToast((s) => s.sticky);
  // Esc dismisses a sticky toast, in the app layer: an open modal (menu layer) takes Esc first.
  useKeys('app', (e) => {
    if (!isDismissKey(e)) return;
    useToast.getState().dismiss();
    e.preventDefault();
    return 'handled';
  }, sticky && !!message);
  if (!message) return null;
  const links: ToastAction[] = action ? [action, ...actions] : actions;
  return (
    <div role={tone === 'warning' ? 'alert' : 'status'} className={tone === 'warning' ? 'toast toast-warning' : 'toast'}>
      {message}
      {links.map((a, i) => (
        <button key={`${i}-${a.label}`} type="button" className="toast-action" onClick={() => { useToast.getState().dismiss(); a.run(); }}>{a.label}</button>
      ))}
      {sticky && <button type="button" className="toast-dismiss" aria-label="Dismiss" onClick={() => useToast.getState().dismiss()}><X size={14} /></button>}
      {detail && <div className="toast-detail">{detail}</div>}
    </div>
  );
}
