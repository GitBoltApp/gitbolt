import { useToast, type ToastAction } from './toast';

export function Toast() {
  const message = useToast((s) => s.message);
  const action = useToast((s) => s.action);
  const actions = useToast((s) => s.actions);
  if (!message) return null;
  const links: ToastAction[] = action ? [action, ...actions] : actions;
  return (
    <div role="status" className="toast">
      {message}
      {links.map((a, i) => (
        <button key={`${i}-${a.label}`} type="button" className="toast-action" onClick={() => { useToast.getState().dismiss(); a.run(); }}>{a.label}</button>
      ))}
    </div>
  );
}
