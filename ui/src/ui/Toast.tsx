import { useToast } from './toast';

export function Toast() {
  const message = useToast((s) => s.message);
  if (!message) return null;
  return <div role="status" className="toast">{message}</div>;
}
