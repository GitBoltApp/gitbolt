import { useToast } from './toast';

export function Toast() {
  const message = useToast((s) => s.message);
  const action = useToast((s) => s.action);
  if (!message) return null;
  return (
    <div role="status" className="toast">
      {message}
      {action && (
        <button type="button" className="toast-action" onClick={() => { useToast.getState().dismiss(); action.run(); }}>{action.label}</button>
      )}
    </div>
  );
}
