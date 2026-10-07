import type { PendingAction } from './store';
import './pending.css';

/** The spinner that takes the checkmark's (or the branch icon's) box while an action runs on a
 * ref: the same box, so nothing shifts. A static dot under reduced motion. */
export function PendingMark({ action, className, size, label = 'working' }: { action: PendingAction; className?: string; size?: number; label?: string }) {
  return <span className={`pending-mark${className ? ` ${className}` : ''}`} data-pending={action} role="status" aria-label={label} style={size ? { width: size, height: size } : undefined} />;
}
