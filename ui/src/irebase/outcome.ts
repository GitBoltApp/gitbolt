import type { IntegrateOutcome } from '../api/gen/IntegrateOutcome';
import { useToast } from '../ui/toast';

// --- 3C T13: what a rebase's Start, Continue or Abort tells afterwards (3C fix rounds 1 and 2) ---
const files = (n: number) => `${n} ${n === 1 ? "file's changes were" : "files' changes were"} discarded`;

/**
 * Toasts what a rebase's outcome says: `done`, its success line, if any. A finished rebase with
 * a `warning` (something after it didn't happen) is a warning toast, the warning under `done`.
 * A stop with a `warning` (3C final fix M1, M2: a hook refused the new message) is a warning
 * toast too. An Abort names the branch that kept the stop's commits, and how many files' changes
 * a conflict stop's abort discarded: a warning toast, timed like the others (3C final fix M3).
 * (A kept stash has the core's own banner, `abortedWork`: no toast for it.)
 */
export function toastRebaseOutcome(out: IntegrateOutcome | null | undefined, done?: string): void {
  if (!out) return;
  const show = useToast.getState().show;
  if (out.status === 'done' || out.status === 'upToDate') {
    if (out.warning) show(done ?? out.warning, { tone: 'warning', detail: done ? out.warning : undefined });
    else if (done) show(done);
    return;
  }
  if (out.status === 'stopped') {
    if (out.warning) show(out.warning, { tone: 'warning' });
    return;
  }
  const parts = [out.branch ? `Your commits from the stop are on ${out.branch}` : null, out.discarded ? files(out.discarded) : null].filter(Boolean);
  if (parts.length) show(parts.join('. '), { tone: 'warning' });
}
// --- end 3C T13 ---
